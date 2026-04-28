// SignalDO — Durable Object for WebSocket-based hole-punching coordination
// Each DO instance handles signaling between a pair (or small group) of peers.
// Peers connect via WebSocket, exchange ICE candidates, and attempt direct connections.
//
// URL: GET /api/signal/:room_id  (room_id = sorted peer key pair hash)

interface SignalMessage {
  type: "join" | "leave" | "candidate" | "offer" | "answer" | "ping" | "pong";
  from?: string; // sender public key
  to?: string;   // target public key (null = broadcast)
  payload?: unknown;
}

interface PeerSession {
  ws: WebSocket;
  publicKey: string;
  joinedAt: number;
}

export class SignalDO implements DurableObject {
  private sessions = new Map<string, PeerSession>(); // publicKey -> session
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    // Require public key as query param (authenticated upstream)
    const publicKey = url.searchParams.get("pk");
    if (!publicKey) {
      return new Response("pk (public key) required", { status: 400 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();

    const session: PeerSession = { ws: server, publicKey, joinedAt: Date.now() };
    this.sessions.set(publicKey, session);

    // Announce join to other peers in this room
    this.broadcast({ type: "join", from: publicKey }, publicKey);

    server.addEventListener("message", (event: MessageEvent) => {
      this.handleMessage(publicKey, event.data as string);
    });

    server.addEventListener("close", () => {
      this.sessions.delete(publicKey);
      this.broadcast({ type: "leave", from: publicKey }, publicKey);
    });

    server.addEventListener("error", () => {
      this.sessions.delete(publicKey);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private handleMessage(fromKey: string, raw: string): void {
    let msg: SignalMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    msg.from = fromKey; // always override from field with authenticated key

    if (msg.type === "ping") {
      const session = this.sessions.get(fromKey);
      session?.ws.send(JSON.stringify({ type: "pong", from: "server" }));
      return;
    }

    // candidate/offer/answer: forward to specific peer or broadcast
    if (msg.to) {
      const target = this.sessions.get(msg.to);
      if (target) {
        try { target.ws.send(JSON.stringify(msg)); } catch { /* peer disconnected */ }
      }
    } else {
      this.broadcast(msg, fromKey);
    }
  }

  private broadcast(msg: SignalMessage, excludeKey?: string): void {
    const data = JSON.stringify(msg);
    for (const [key, session] of this.sessions) {
      if (key === excludeKey) continue;
      try { session.ws.send(data); } catch { this.sessions.delete(key); }
    }
  }
}
