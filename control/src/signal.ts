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
  // Token bucket for inbound signaling (H12). Tokens regenerate at
  // RATE_TOKENS_PER_SEC, capped at RATE_BURST. Each handled message costs 1
  // token; running dry closes the socket with 1008.
  tokens: number;
  tokensUpdatedAt: number;
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
// H12: per-session token bucket. Sustained 50 msg/s with burst capacity of
// 100 comfortably covers ICE candidate flurries (typically <30 candidates per
// peer per gather) while shutting down a misbehaving client before it can
// saturate the DO's CPU or fan out a broadcast storm to room peers.
const RATE_TOKENS_PER_SEC = 50;
const RATE_BURST = 100;
// J12: hard cap on replay-cache entries per DO. Without this a malicious peer
// can spam offer/answer with unique cacheKey values (varying msg.to) to grow
// the Map until DO memory is exhausted. The cap is enforced FIFO-by-insertion
// (Map iteration order is insertion order in JS), evicting the oldest entry
// when a new one would exceed the cap. 256 fits ~5MB at 16KiB max each.
const MAX_REPLAY_CACHE_ENTRIES = 256;
const MAX_SESSIONS = 64;

export class SignalDO implements DurableObject {
  private sessions = new Map<string, PeerSession>();
  // Key: `${from}->${to}` (or `${from}->*` for broadcast) -> last offer/answer.
  private replayCache = new Map<string, CachedSignal>();
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
    for (const ws of state.getWebSockets()) {
      const saved = ws.deserializeAttachment() as Omit<PeerSession, "ws"> | null;
      if (saved) this.sessions.set(saved.publicKey, { ...saved, ws });
    }
    // Attachments preserve sessions, but exceed neither their 2 KiB limit nor
    // the 30-second replay contract by putting SDP payloads in SQLite instead.
    state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS signal_replay (
      key TEXT PRIMARY KEY, message TEXT NOT NULL, cached_at INTEGER NOT NULL
    )`);
    state.storage.sql.exec("DELETE FROM signal_replay WHERE cached_at < ?", Date.now() - REPLAY_WINDOW_MS);
    const rows = state.storage.sql.exec<{ key: string; message: string; cached_at: number }>(
      "SELECT key, message, cached_at FROM signal_replay WHERE cached_at >= ? ORDER BY cached_at, key",
      Date.now() - REPLAY_WINDOW_MS,
    );
    for (const row of rows) {
      this.replayCache.set(row.key, { msg: JSON.parse(row.message), cachedAt: row.cached_at });
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const publicKey = url.searchParams.get("pk");
    if (!publicKey) {
      return new Response("pk (public key) required", { status: 400 });
    }

    // If a previous session for this pk is still around (reconnect), close it first.
    const existing = this.sessions.get(publicKey);
    if (!existing && this.sessions.size >= MAX_SESSIONS) {
      return new Response("Signal room is full", { status: 429 });
    }
    if (existing) {
      this.sessions.delete(publicKey);
      existing.ws.serializeAttachment(null);
      try { existing.ws.close(1000, "superseded"); } catch { /* ignore */ }
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.state.acceptWebSocket(server);

    const now = Date.now();
    const session: PeerSession = {
      ws: server,
      publicKey,
      joinedAt: now,
      lastSeen: now,
      tokens: RATE_BURST,
      tokensUpdatedAt: now,
    };
    this.sessions.set(publicKey, session);
    this.saveSession(session);

    // Tell the new peer who's already here, then announce them to everyone.
    const others = [...this.sessions.keys()].filter((k) => k !== publicKey);
    server.send(JSON.stringify({ type: "join", from: "server", peers: [publicKey, ...others] } satisfies SignalMessage));
    this.broadcast({ type: "join", from: publicKey }, publicKey);

    // G19: every membership change in a paired-or-larger room rebroadcasts
    // the current peer set so 3+-person rooms see additions, not just the
    // initial 1→2 transition. UI relies on this to refresh status without
    // polling. The "paired" event name is kept for backward compatibility;
    // it now means "current peer set in a multi-peer room".
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

    // Do not postpone an existing sweep on each reconnect.
    if (await this.state.storage.getAlarm() === null) {
      await this.state.storage.setAlarm(now + ALARM_INTERVAL_MS);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const session = this.activeSession(ws);
    if (session) this.handleMessage(session.publicKey, message);
  }

  webSocketClose(ws: WebSocket, code: number): void {
    const session = this.activeSession(ws);
    if (session) this.dropSession(session.publicKey);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code); } catch { /* already closed */ }
  }

  webSocketError(ws: WebSocket): void {
    const session = this.activeSession(ws);
    if (session) this.dropSession(session.publicKey);
    try { ws.close(1011, "WebSocket error"); } catch { /* already closed */ }
  }

  private activeSession(ws: WebSocket): PeerSession | undefined {
    const saved = ws.deserializeAttachment() as Omit<PeerSession, "ws"> | null;
    if (!saved) return;
    const current = this.sessions.get(saved.publicKey);
    return current?.ws === ws ? current : undefined;
  }

  private saveSession(session: PeerSession): void {
    const { ws, ...saved } = session;
    ws.serializeAttachment(saved);
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
    this.state.storage.sql.exec("DELETE FROM signal_replay WHERE cached_at < ?", now - REPLAY_WINDOW_MS);
    // A final sweep must also retire persisted replay data after the last
    // socket closes, otherwise a quiet object retains stale payloads forever.
    if (this.sessions.size > 0 || this.replayCache.size > 0) {
      await this.state.storage.setAlarm(now + ALARM_INTERVAL_MS);
    }
  }

  private dropSession(publicKey: string): void {
    this.sessions.get(publicKey)?.ws.serializeAttachment(null);
    if (!this.sessions.delete(publicKey)) return;
    this.broadcast({ type: "leave", from: publicKey });
    // G19: drop-with-≥2-remaining used to be silent; now we re-emit "paired"
    // with the current peer set so every membership change keeps clients in
    // sync. Falling below 2 emits "unpaired" exactly as before.
    if (this.sessions.size >= 2) {
      this.broadcast({ type: "paired", from: "server", peers: [...this.sessions.keys()] });
    } else {
      this.broadcast({ type: "unpaired", from: "server", peers: [...this.sessions.keys()] });
    }
  }

  private handleMessage(fromKey: string, raw: string | ArrayBuffer): void {
    const session = this.sessions.get(fromKey);
    if (!session) return;
    if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) {
      const s = this.sessions.get(fromKey);
      try { s?.ws.close(1009, "message too large"); } catch { /* ignore */ }
      this.dropSession(fromKey);
      return;
    }
    if (session) {
      // Refill bucket based on time elapsed since the last message.
      const now = Date.now();
      const elapsedSec = (now - session.tokensUpdatedAt) / 1000;
      session.tokens = Math.min(RATE_BURST, session.tokens + elapsedSec * RATE_TOKENS_PER_SEC);
      session.tokensUpdatedAt = now;
      if (session.tokens < 1) {
        try { session.ws.close(1008, "rate limit exceeded"); } catch { /* ignore */ }
        this.dropSession(fromKey);
        return;
      }
      session.tokens -= 1;
      this.saveSession(session);
    }
    let msg: SignalMessage;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    if (msg.to !== undefined && (typeof msg.to !== "string" || msg.to.length > 128)) return;

    // O3: only client-originated message types are honored. Without this
    // check a peer could spoof server-origin events (paired/unpaired/
    // join/leave/pong) to other peers in the room and corrupt their
    // pairing state — `from` is overwritten below, but the type field
    // would still be attacker-controlled. The TS union on SignalMessage
    // is compile-time only and offers no runtime protection.
    const ALLOWED_INBOUND = new Set(["ping", "offer", "answer", "candidate"]);
    if (typeof msg.type !== "string" || !ALLOWED_INBOUND.has(msg.type)) {
      return;
    }

    msg.from = fromKey; // override: clients can't spoof
    session.lastSeen = Date.now();
    this.saveSession(session);

    if (msg.type === "ping") {
      session?.ws.send(JSON.stringify({ type: "pong", from: "server" }));
      return;
    }

    // Cache offer/answer for short replay window (helps reconnect-and-resume).
    // Key includes msg.type so independent streams (e.g. voice offer vs screen
    // share offer) don't overwrite each other.
    if (msg.type === "offer" || msg.type === "answer") {
      const cacheKey = `${msg.type}:${fromKey}->${msg.to ?? "*"}`;
      // J12: evict oldest before insert if at capacity. Map iteration order
      // is insertion order, so the first key is the oldest. Refresh-on-update
      // is achieved by deleting then setting (cheap; bounded by cap).
      this.replayCache.delete(cacheKey);
      if (this.replayCache.size >= MAX_REPLAY_CACHE_ENTRIES) {
        const oldest = this.replayCache.keys().next().value;
        if (oldest !== undefined) {
          this.state.storage.sql.exec("DELETE FROM signal_replay WHERE key = ?", oldest);
          this.replayCache.delete(oldest);
        }
      }
      this.state.storage.sql.exec(
        "INSERT OR REPLACE INTO signal_replay (key, message, cached_at) VALUES (?, ?, ?)",
        cacheKey, JSON.stringify(msg), Date.now(),
      );
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
      try { session.ws.send(data); } catch {
        session.ws.serializeAttachment(null);
        this.sessions.delete(key);
        try { session.ws.close(1011, "send failed"); } catch { /* already closed */ }
      }
    }
  }
}
