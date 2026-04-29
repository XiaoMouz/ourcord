// SignalDO — Durable Object for WebSocket-based hole-punching coordination.
//
// Each DO instance handles signaling for a single "room" (typically a peer
// pair, room_id = sorted hash of the two public keys). Peers connect via WS,
// the DO forwards offer/answer/candidate messages and tells participants when
// the other side is present so the daemon knows when to start ICE.
//
// Pairing semantics (C5):
//   - On connect, a peer is added to `sessions`.
//   - When a second peer joins, the DO broadcasts { type: "paired", peers: [...] }
//     so both sides know it's safe to send their first offer.
//   - The most recent offer/answer per (from, to) pair is cached briefly so a
//     peer that disconnects + reconnects within the replay window doesn't have
//     to wait for the other side to retransmit.
//   - Stale sessions (no message in `staleAfterMs`) are pruned via the DO alarm.

interface SignalMessage {
  type: "join" | "leave" | "paired" | "unpaired" | "candidate" | "offer" | "answer" | "ping" | "pong";
  from?: string;
  to?: string;
  payload?: unknown;
  peers?: string[]; // for "paired"
}

interface PeerSession {
  ws: WebSocket;
  publicKey: string;
  joinedAt: number;
  lastSeen: number;
}

interface CachedSignal {
  msg: SignalMessage;
  cachedAt: number;
}

const REPLAY_WINDOW_MS = 30_000;
const STALE_AFTER_MS = 90_000;
const ALARM_INTERVAL_MS = 30_000;
// Hard cap on a single signal-message size. Hole-punching offers/answers and
// ICE candidates are <2 KiB in practice; anything beyond this is a malicious
// or misbehaving client trying to exhaust DO memory or saturate forward fanout.
const MAX_MESSAGE_BYTES = 16 * 1024;

export class SignalDO implements DurableObject {
  private sessions = new Map<string, PeerSession>();
  // Key: `${from}->${to}` (or `${from}->*` for broadcast) -> last offer/answer.
  private replayCache = new Map<string, CachedSignal>();
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const publicKey = url.searchParams.get("pk");
    if (!publicKey) {
      return new Response("pk (public key) required", { status: 400 });
    }

    // If a previous session for this pk is still around (reconnect), close it first.
    const existing = this.sessions.get(publicKey);
    if (existing) {
      try { existing.ws.close(1000, "superseded"); } catch { /* ignore */ }
      this.sessions.delete(publicKey);
    }

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();

    const now = Date.now();
    const session: PeerSession = { ws: server, publicKey, joinedAt: now, lastSeen: now };
    this.sessions.set(publicKey, session);

    // Tell the new peer who's already here, then announce them to everyone.
    const others = [...this.sessions.keys()].filter((k) => k !== publicKey);
    server.send(JSON.stringify({ type: "join", from: "server", peers: [publicKey, ...others] } satisfies SignalMessage));
    this.broadcast({ type: "join", from: publicKey }, publicKey);

    // If this connect makes the room a pair (or larger), notify everyone.
    if (this.sessions.size >= 2) {
      const peers = [...this.sessions.keys()];
      this.broadcast({ type: "paired", from: "server", peers });
    }

    // Replay any cached offer/answer addressed to this peer (from anyone in the room).
    for (const [key, entry] of this.replayCache) {
      if (now - entry.cachedAt > REPLAY_WINDOW_MS) { this.replayCache.delete(key); continue; }
      // Key format: `${type}:${from}->${to}`. We only need the addressee.
      const arrowIdx = key.indexOf("->");
      const to = arrowIdx >= 0 ? key.slice(arrowIdx + 2) : "";
      if (to === publicKey || to === "*") {
        try { server.send(JSON.stringify(entry.msg)); } catch { /* ignore */ }
      }
    }

    server.addEventListener("message", (event: MessageEvent) => {
      this.handleMessage(publicKey, event.data as string);
    });
    server.addEventListener("close", () => this.dropSession(publicKey));
    server.addEventListener("error", () => this.dropSession(publicKey));

    // Schedule the next stale-sweep.
    void this.state.storage.setAlarm(now + ALARM_INTERVAL_MS);

    return new Response(null, { status: 101, webSocket: client });
  }

  // alarm is invoked by the runtime; prune stale sessions and reschedule.
  async alarm(): Promise<void> {
    const now = Date.now();
    for (const [key, s] of this.sessions) {
      if (now - s.lastSeen > STALE_AFTER_MS) {
        try { s.ws.close(1000, "stale"); } catch { /* ignore */ }
        this.dropSession(key);
      }
    }
    for (const [key, entry] of this.replayCache) {
      if (now - entry.cachedAt > REPLAY_WINDOW_MS) this.replayCache.delete(key);
    }
    if (this.sessions.size > 0) {
      await this.state.storage.setAlarm(now + ALARM_INTERVAL_MS);
    }
  }

  private dropSession(publicKey: string): void {
    if (!this.sessions.delete(publicKey)) return;
    this.broadcast({ type: "leave", from: publicKey });
    if (this.sessions.size < 2) {
      this.broadcast({ type: "unpaired", from: "server", peers: [...this.sessions.keys()] });
    }
  }

  private handleMessage(fromKey: string, raw: string): void {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE_BYTES) {
      const s = this.sessions.get(fromKey);
      try { s?.ws.close(1009, "message too large"); } catch { /* ignore */ }
      this.dropSession(fromKey);
      return;
    }
    let msg: SignalMessage;
    try { msg = JSON.parse(raw); } catch { return; }

    msg.from = fromKey; // override: clients can't spoof
    const session = this.sessions.get(fromKey);
    if (session) session.lastSeen = Date.now();

    if (msg.type === "ping") {
      session?.ws.send(JSON.stringify({ type: "pong", from: "server" }));
      return;
    }

    // Cache offer/answer for short replay window (helps reconnect-and-resume).
    // Key includes msg.type so independent streams (e.g. voice offer vs screen
    // share offer) don't overwrite each other.
    if (msg.type === "offer" || msg.type === "answer") {
      const cacheKey = `${msg.type}:${fromKey}->${msg.to ?? "*"}`;
      this.replayCache.set(cacheKey, { msg, cachedAt: Date.now() });
    }

    if (msg.to) {
      const target = this.sessions.get(msg.to);
      if (target) {
        try { target.ws.send(JSON.stringify(msg)); } catch { /* peer disconnected */ }
      }
      // If the addressee isn't here yet, the cache above will replay on join.
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
