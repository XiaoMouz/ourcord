import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import worker from "./index";
import { SignalDO } from "./signal";
import { signToken, makeToken as makePayload } from "./auth";
import type { Env } from "./types";
import { DatabaseSync } from "node:sqlite";

// ─── Test plumbing ────────────────────────────────────────────────────────────
//
// SignalDO is exercised in two layers:
//
//  1. Route-gate tests go through the worker fetch handler in index.ts so we
//     verify auth/membership/rate-limit/banned checks short-circuit before
//     the DO is ever instantiated.
//  2. DO behavior tests instantiate SignalDO directly and either drive the
//     `fetch` handshake with a stubbed `WebSocketPair`/`Response` (for the
//     upgrade flow) or exercise message handling by injecting fake sessions
//     into the private `sessions` map and dispatching message events on the
//     mock WebSocket.

const SECRET = "signal-test-jwt-secret-1234567890";
const PK_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const PK_B = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const PK_C = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=";
const ROOM_AB = "pair:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const ROOM_BA = "pair:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function tokenFor(sub = "u1"): Promise<string> {
  return signToken(makePayload(sub, `${sub}@x.io`), SECRET);
}

type DBStep = { first?: unknown; run?: unknown; all?: unknown };
function makeDB(plan: DBStep[]): D1Database {
  let i = 0;
  return {
    prepare: vi.fn(() => {
      const idx = i++;
      const step = () => plan[idx] || {};
      const s: any = {
        bind: () => s,
        first: vi.fn(async () => step().first ?? null),
        run: vi.fn(async () => step().run ?? { meta: { changes: 1 } }),
        all: vi.fn(async () => step().all ?? { results: [] }),
      };
      return s as D1PreparedStatement;
    }),
    batch: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;
}

function makeKV(values: Record<string, string> = {}): KVNamespace {
  return {
    get: vi.fn(async (k: string) => values[k] ?? null),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
  } as unknown as KVNamespace;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: makeDB([{ first: { 1: 1 } }]),
    KV: makeKV(),
    SIGNAL: {
      idFromName: vi.fn(() => ({} as DurableObjectId)),
      get: vi.fn(() => ({ fetch: vi.fn(async () => new Response("do-not-reached", { status: 599 })) } as unknown as DurableObjectStub)),
    } as unknown as DurableObjectNamespace,
    ENVIRONMENT: "production",
    JWT_SECRET: SECRET,
    RATE_LIMIT_60: { limit: vi.fn(async () => ({ success: true })) },
    ...overrides,
  } as Env;
}

const ctx = {} as ExecutionContext;

function signalReq(roomId: string, qs: Record<string, string> = {}): Request {
  const url = new URL(`https://control.example/api/signal/${roomId}`);
  for (const [k, v] of Object.entries(qs)) url.searchParams.set(k, v);
  return new Request(url.toString(), { method: "GET", headers: { Upgrade: "websocket" } });
}

// ─── Route-gate tests (index.ts wiring → SignalDO) ─────────────────────────

describe("/api/signal route gate (W3)", () => {
  it("rejects ordinary HTTP requests before rate limiting or D1", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://control.test/api/signal/room"), env, ctx);
    expect(res.status).toBe(426);
    expect(env.DB.prepare).not.toHaveBeenCalled();
    expect(env.RATE_LIMIT_60!.limit).not.toHaveBeenCalled();
  });

  it("does not allocate a pair DO for a random unregistered peer", async () => {
    const env = makeEnv({ DB: makeDB([{ first: { 1: 1 } }, { first: null }, { first: null }]) });
    const res = await worker.fetch(signalReq(ROOM_AB, { token: await tokenFor(), pk: PK_A }), env, ctx);
    expect(res.status).toBe(404);
    expect(env.SIGNAL.idFromName).not.toHaveBeenCalled();
  });

  it("forwards a valid pair with two registered peers", async () => {
    const env = makeEnv({ DB: makeDB([{ first: { 1: 1 } }, { first: null }, { first: { 1: 1 } }]) });
    const res = await worker.fetch(signalReq(ROOM_AB, { token: await tokenFor(), pk: PK_A }), env, ctx);
    expect(res.status).toBe(599);
    expect(env.SIGNAL.idFromName).toHaveBeenCalledWith(ROOM_AB);
  });
  it("missing token + pk → 401", async () => {
    const res = await worker.fetch(signalReq(ROOM_AB), makeEnv(), ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: /token and pk required/ });
  });

  it("invalid JWT → 401", async () => {
    const res = await worker.fetch(
      signalReq(ROOM_AB, { token: "not.a.jwt", pk: PK_A }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid token" });
  });

  it("valid JWT but peer not owned by user → 403", async () => {
    const env = makeEnv({ DB: makeDB([{ first: null }]) });
    const res = await worker.fetch(
      signalReq(ROOM_AB, { token: await tokenFor("u1"), pk: PK_A }),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "peer not owned by user" });
  });

  it("rejects a banned user with a still-valid token before allocating a DO", async () => {
    const env = makeEnv({ DB: makeDB([{ first: { 1: 1 } }, { first: { id: "ban1" } }]) });
    const res = await worker.fetch(signalReq(ROOM_AB, { token: await tokenFor(), pk: PK_A }), env, ctx);
    expect(res.status).toBe(401);
    expect(env.SIGNAL.idFromName).not.toHaveBeenCalled();
  });

  it("malformed pair roomId → 400", async () => {
    const env = makeEnv({ DB: makeDB([{ first: { 1: 1 } }]) });
    const res = await worker.fetch(
      signalReq("pair:onlyone", { token: await tokenFor(), pk: "aaa" }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: /malformed pair/ });
  });

  it("pair roomId not sorted → 400", async () => {
    const env = makeEnv({ DB: makeDB([{ first: { 1: 1 } }]) });
    const res = await worker.fetch(
      signalReq(ROOM_BA, { token: await tokenFor(), pk: PK_B }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: /malformed pair/ });
  });

  it("authenticated user not part of the pair → 403 (cross-pair signaling rejected)", async () => {
    const env = makeEnv({ DB: makeDB([{ first: { 1: 1 } }]) });
    const res = await worker.fetch(
      signalReq(ROOM_AB, { token: await tokenFor(), pk: PK_C }),
      env,
      ctx,
    );
    // ownership check passes (mock returns row for any pk), but membership
    // check then rejects ccc since it's not aaa or bbb.
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "pk not part of this pair" });
  });

  it("service room without SERVICE_URL config → 503", async () => {
    const env = makeEnv({ DB: makeDB([{ first: { 1: 1 } }]) });
    const res = await worker.fetch(
      signalReq("lobby-1", { token: await tokenFor(), pk: "aaa" }),
      env,
      ctx,
    );
    expect(res.status).toBe(503);
  });

  it("rate-limited (X6) → 429 before any auth work", async () => {
    const env = makeEnv({
      KV: makeKV({ [`__seed`]: "" }),
    });
    // Reject at the native binding before any authentication/storage work.
    env.RATE_LIMIT_60 = { limit: vi.fn(async () => ({ success: false })) };
    const res = await worker.fetch(
      signalReq(ROOM_AB, { token: await tokenFor(), pk: PK_A }),
      env,
      ctx,
    );
    expect(res.status).toBe(429);
  });
});

// ─── SignalDO direct tests ────────────────────────────────────────────────

// Minimal mock matching the surface SignalDO touches on its server-side WS:
// accept(), send(), close(), and addEventListener for "message"/"close"/"error".
class MockWS {
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  accepted = false;
  attachment: unknown = null;
  serializeAttachment(value: unknown) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
  private listeners: Record<string, Array<(e: any) => void>> = {};
  accept() { this.accepted = true; }
  send(data: string) { this.sent.push(data); }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.dispatch("close", {});
  }
  addEventListener(type: string, listener: (e: any) => void) {
    (this.listeners[type] ||= []).push(listener);
  }
  dispatch(type: string, ev: any) {
    for (const l of this.listeners[type] || []) l(ev);
  }
  // Convenience: simulate a peer sending a message.
  inbound(data: string) { this.dispatch("message", { data }); }
  lastSent(): any { return this.sent.length ? JSON.parse(this.sent[this.sent.length - 1]) : null; }
  sentMessages(): any[] { return this.sent.map((s) => JSON.parse(s)); }
}

function makeState(): DurableObjectState {
  const db = new DatabaseSync(":memory:");
  const sockets: MockWS[] = [];
  let alarm: number | null = null;
  return {
    getWebSockets: () => sockets.filter((ws) => !ws.closed),
    acceptWebSocket: (ws: MockWS) => { ws.accepted = true; sockets.push(ws); },
    storage: {
      sql: { exec: (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) },
      setAlarm: vi.fn(async (value: number) => { alarm = value; }),
      getAlarm: vi.fn(async () => alarm),
      deleteAlarm: vi.fn(async () => { alarm = null; }),
    },
  } as unknown as DurableObjectState;
}

// Stash & restore the WebSocketPair/Response globals only for the DO upgrade
// tests; index.ts tests need the real Response constructor.
const RealResponse = globalThis.Response;
class FakeResponse {
  status: number;
  webSocket: any;
  headers = new Headers();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(_body: any, init: any) {
    this.status = init?.status ?? 200;
    this.webSocket = init?.webSocket;
  }
}

function installFakeWS(): { client: MockWS; server: MockWS } {
  const client = new MockWS();
  const server = new MockWS();
  (globalThis as any).WebSocketPair = function () {
    return { 0: client, 1: server };
  };
  (globalThis as any).Response = FakeResponse;
  return { client, server };
}

function restoreGlobals() {
  delete (globalThis as any).WebSocketPair;
  (globalThis as any).Response = RealResponse;
}

describe("SignalDO.fetch upgrade handshake", () => {
  beforeEach(() => restoreGlobals());
  afterAll(() => restoreGlobals());

  it("rejects non-websocket requests with 426", async () => {
    installFakeWS();
    const sigDO = new SignalDO(makeState());
    const req = new Request("https://do.example/?pk=alice");
    const res = (await sigDO.fetch(req)) as unknown as FakeResponse;
    expect(res.status).toBe(426);
    restoreGlobals();
  });

  it("returns a websocket on a valid upgrade and emits initial join", async () => {
    const { client, server } = installFakeWS();
    const sigDO = new SignalDO(makeState());
    const req = new Request("https://do.example/?pk=alice", {
      headers: { Upgrade: "websocket" },
    });
    const res = (await sigDO.fetch(req)) as unknown as FakeResponse;
    expect(res.status).toBe(101);
    expect(res.webSocket).toBe(client);
    expect(server.accepted).toBe(true);
    // First server-→client message is the join roster.
    const first = server.sentMessages()[0];
    expect(first).toMatchObject({ type: "join", from: "server", peers: ["alice"] });
    restoreGlobals();
  });

  it("missing pk → 400", async () => {
    installFakeWS();
    const sigDO = new SignalDO(makeState());
    const req = new Request("https://do.example/", { headers: { Upgrade: "websocket" } });
    const res = (await sigDO.fetch(req)) as unknown as FakeResponse;
    expect(res.status).toBe(400);
    restoreGlobals();
  });

  it("restores the roster, rate bucket and replay after hibernation", async () => {
    const state = makeState();
    const { server: alice } = installFakeWS();
    let sig = new SignalDO(state);
    await sig.fetch(new Request("https://do.example/?pk=alice", { headers: { Upgrade: "websocket" } }));
    sig.webSocketMessage(alice as unknown as WebSocket, JSON.stringify({ type: "offer", to: "bob", payload: "sdp" }));
    const tokens = (alice.attachment as { tokens: number }).tokens;
    sig = new SignalDO(state);
    const { server: bob } = installFakeWS();
    await sig.fetch(new Request("https://do.example/?pk=bob", { headers: { Upgrade: "websocket" } }));
    expect(bob.sentMessages()).toContainEqual({ type: "offer", from: "alice", to: "bob", payload: "sdp" });
    expect((sig as any).sessions.get("alice").tokens).toBe(tokens);
    sig.webSocketMessage(bob as unknown as WebSocket, JSON.stringify({ type: "candidate", to: "alice" }));
    expect(alice.lastSent()).toMatchObject({ type: "candidate", from: "bob" });
    expect(state.storage.setAlarm).toHaveBeenCalledTimes(1);
  });

  it("ignores delayed close and message events from a superseded socket", async () => {
    const sig = new SignalDO(makeState());
    const req = () => new Request("https://do.example/?pk=alice", { headers: { Upgrade: "websocket" } });
    const { server: old } = installFakeWS();
    await sig.fetch(req());
    const { server: current } = installFakeWS();
    await sig.fetch(req());
    sig.webSocketClose(old as unknown as WebSocket, 1000);
    sig.webSocketMessage(old as unknown as WebSocket, JSON.stringify({ type: "offer", to: "bob" }));
    expect((sig as any).sessions.get("alice").ws).toBe(current);
    expect((sig as any).replayCache.size).toBe(0);
    sig.webSocketMessage(current as unknown as WebSocket, JSON.stringify({ type: "ping" }));
    expect(current.lastSent()).toMatchObject({ type: "pong" });
  });

  it("does not replay expired offers after hibernation", async () => {
    const state = makeState();
    state.storage.sql.exec("CREATE TABLE signal_replay (key TEXT PRIMARY KEY, message TEXT, cached_at INTEGER)");
    state.storage.sql.exec("INSERT INTO signal_replay VALUES (?, ?, ?)", "offer:alice->bob", '{"type":"offer"}', Date.now() - 31_000);
    installFakeWS();
    const sig = new SignalDO(state);
    await sig.fetch(new Request("https://do.example/?pk=bob", { headers: { Upgrade: "websocket" } }));
    expect((sig as any).replayCache.size).toBe(0);
  });

  it("retires persisted replay data after the last socket leaves", async () => {
    const state = makeState();
    const { server } = installFakeWS();
    const sig = new SignalDO(state);
    await sig.fetch(new Request("https://do.example/?pk=alice", { headers: { Upgrade: "websocket" } }));
    sig.webSocketMessage(server as unknown as WebSocket, JSON.stringify({ type: "offer", to: "bob" }));
    sig.webSocketClose(server as unknown as WebSocket, 1000);
    await sig.alarm();
    expect(state.storage.setAlarm).toHaveBeenCalledTimes(2);
    for (const entry of (sig as any).replayCache.values()) entry.cachedAt -= 31_000;
    state.storage.sql.exec("UPDATE signal_replay SET cached_at = cached_at - 31000");
    await sig.alarm();
    expect([...state.storage.sql.exec("SELECT key FROM signal_replay")]).toEqual([]);
    expect(state.storage.setAlarm).toHaveBeenCalledTimes(2);
  });
});

// For the message-handling tests we drive SignalDO by manipulating its
// private `sessions` map directly. This is more deterministic than running
// the upgrade twice and lets us assert per-peer effects without juggling two
// pairs of mocked sockets through fetch().
describe("SignalDO message routing (C5/H12/J12/O3)", () => {
  function seed(): { sigDO: SignalDO; alice: MockWS; bob: MockWS } {
    const sigDO = new SignalDO(makeState());
    const alice = new MockWS();
    const bob = new MockWS();
    const now = Date.now();
    const sessions: Map<string, any> = (sigDO as any).sessions;
    sessions.set("alice", { ws: alice, publicKey: "alice", joinedAt: now, lastSeen: now, tokens: 100, tokensUpdatedAt: now });
    sessions.set("bob", { ws: bob, publicKey: "bob", joinedAt: now, lastSeen: now, tokens: 100, tokensUpdatedAt: now });
    return { sigDO, alice, bob };
  }

  it("offer from alice→bob is forwarded verbatim with from overridden", async () => {
    const { sigDO, alice, bob } = seed();
    (sigDO as any).handleMessage("alice", JSON.stringify({
      type: "offer", to: "bob", payload: { sdp: "v=0..." },
    }));
    const got = bob.lastSent();
    expect(got).toMatchObject({ type: "offer", from: "alice", to: "bob", payload: { sdp: "v=0..." } });
    // Sender does not echo to itself.
    expect(alice.sentMessages()).toEqual([]);
  });

  it("answer from bob→alice is forwarded back", async () => {
    const { sigDO, alice, bob } = seed();
    (sigDO as any).handleMessage("bob", JSON.stringify({
      type: "answer", to: "alice", payload: { sdp: "answer-sdp" },
    }));
    expect(alice.lastSent()).toMatchObject({ type: "answer", from: "bob", to: "alice" });
    expect(bob.sentMessages()).toEqual([]);
  });

  it("ICE candidates flow in both directions", async () => {
    const { sigDO, alice, bob } = seed();
    (sigDO as any).handleMessage("alice", JSON.stringify({ type: "candidate", to: "bob", payload: { c: "a" } }));
    (sigDO as any).handleMessage("bob",   JSON.stringify({ type: "candidate", to: "alice", payload: { c: "b" } }));
    expect(bob.lastSent()).toMatchObject({ type: "candidate", from: "alice", payload: { c: "a" } });
    expect(alice.lastSent()).toMatchObject({ type: "candidate", from: "bob", payload: { c: "b" } });
  });

  it("client cannot spoof from-field; server overrides it", async () => {
    const { sigDO, bob } = seed();
    (sigDO as any).handleMessage("alice", JSON.stringify({
      type: "offer", from: "attacker", to: "bob", payload: {},
    }));
    expect(bob.lastSent().from).toBe("alice");
  });

  it("unknown / server-origin message types are silently ignored (O3)", async () => {
    const { sigDO, alice, bob } = seed();
    for (const type of ["paired", "unpaired", "join", "leave", "pong", "garbage"]) {
      (sigDO as any).handleMessage("alice", JSON.stringify({ type, to: "bob" }));
    }
    expect(bob.sentMessages()).toEqual([]);
    expect(alice.sentMessages()).toEqual([]);
  });

  it("malformed JSON is dropped without throwing", async () => {
    const { sigDO, bob } = seed();
    expect(() => (sigDO as any).handleMessage("alice", "{not json")).not.toThrow();
    expect(bob.sentMessages()).toEqual([]);
    for (const value of ["null", "[]", "123", '"str"']) {
      expect(() => (sigDO as any).handleMessage("alice", value)).not.toThrow();
    }
  });

  it("ping triggers a server pong back to the sender only", async () => {
    const { sigDO, alice, bob } = seed();
    (sigDO as any).handleMessage("alice", JSON.stringify({ type: "ping" }));
    expect(alice.lastSent()).toMatchObject({ type: "pong", from: "server" });
    expect(bob.sentMessages()).toEqual([]);
  });

  it("oversized message closes the socket with 1009 and drops the session", async () => {
    const { sigDO, alice, bob } = seed();
    const huge = "x".repeat(17 * 1024);
    (sigDO as any).handleMessage("alice", huge);
    expect(alice.closed).toMatchObject({ code: 1009 });
    expect((sigDO as any).sessions.has("alice")).toBe(false);
    // bob should be told alice left.
    expect(bob.sentMessages().some((m) => m.type === "leave" && m.from === "alice")).toBe(true);
  });

  it("rate-limit exhaustion closes the socket with 1008", async () => {
    const { sigDO, alice } = seed();
    // Drain the bucket to <1 token.
    (sigDO as any).sessions.get("alice").tokens = 0.5;
    (sigDO as any).sessions.get("alice").tokensUpdatedAt = Date.now();
    (sigDO as any).handleMessage("alice", JSON.stringify({ type: "ping" }));
    expect(alice.closed).toMatchObject({ code: 1008, reason: "rate limit exceeded" });
    expect((sigDO as any).sessions.has("alice")).toBe(false);
  });

  it("dropping a peer broadcasts leave + unpaired when only one remains", () => {
    const { sigDO, alice, bob } = seed();
    (sigDO as any).dropSession("alice");
    const types = bob.sentMessages().map((m) => m.type);
    expect(types).toContain("leave");
    expect(types).toContain("unpaired");
    expect(alice.sentMessages()).toEqual([]); // alice was removed before broadcast
  });

  it("broadcast (no `to`) fans out to everyone except the sender", () => {
    const sigDO = new SignalDO(makeState());
    const a = new MockWS(); const b = new MockWS(); const c = new MockWS();
    const now = Date.now();
    const sessions: Map<string, any> = (sigDO as any).sessions;
    for (const [k, ws] of [["a", a], ["b", b], ["c", c]] as const) {
      sessions.set(k, { ws, publicKey: k, joinedAt: now, lastSeen: now, tokens: 100, tokensUpdatedAt: now });
    }
    (sigDO as any).handleMessage("a", JSON.stringify({ type: "offer", payload: { x: 1 } }));
    expect(a.sentMessages()).toEqual([]);
    expect(b.lastSent()).toMatchObject({ type: "offer", from: "a" });
    expect(c.lastSent()).toMatchObject({ type: "offer", from: "a" });
  });

  it("offer addressed to an absent peer is cached and replayed on join", async () => {
    const { server: _ignore } = installFakeWS();
    void _ignore;
    const sigDO = new SignalDO(makeState());
    // Seed alice only.
    const alice = new MockWS();
    const now = Date.now();
    (sigDO as any).sessions.set("alice", {
      ws: alice, publicKey: "alice", joinedAt: now, lastSeen: now, tokens: 100, tokensUpdatedAt: now,
    });
    // alice posts an offer for bob, who isn't here yet → caches.
    (sigDO as any).handleMessage("alice", JSON.stringify({ type: "offer", to: "bob", payload: { sdp: "x" } }));
    expect((sigDO as any).replayCache.size).toBe(1);

    // Now bob joins via the upgrade flow (uses the fake WS pair).
    const bobReq = new Request("https://do.example/?pk=bob", { headers: { Upgrade: "websocket" } });
    await sigDO.fetch(bobReq);
    // The fake pair we installed maps to a single shared server socket, so we
    // pull bob's session out of the DO and inspect its sends directly.
    const bobWs = (sigDO as any).sessions.get("bob").ws as MockWS;
    const replayed = bobWs.sentMessages().find((m) => m.type === "offer" && m.from === "alice");
    expect(replayed).toBeTruthy();
    expect(replayed).toMatchObject({ to: "bob", payload: { sdp: "x" } });
    restoreGlobals();
  });
});
