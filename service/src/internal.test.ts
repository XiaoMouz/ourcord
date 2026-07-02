import { describe, it, expect, vi } from "vitest";
import worker from "./index";
import { INTERNAL_SIG_WINDOW_SEC } from "./internalAuth";
import type { Env } from "./types";

// Mirrors control/src/internalAuth.ts signInternalHeaders so the tests
// exercise the real wire contract end to end.
async function signInternal(
  secret: string,
  method: string,
  url: string,
  opts: { ts?: number; nonce?: string } = {},
): Promise<Record<string, string>> {
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const nonce =
    opts.nonce ??
    [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const u = new URL(url);
  const payload = `${ts}\n${nonce}\n${method.toUpperCase()}\n${u.pathname}${u.search}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return { "X-Internal-Ts": ts, "X-Internal-Nonce": nonce, "X-Internal-Sig": sig };
}

type DBStep = { first?: unknown; all?: unknown; run?: unknown };

function makeDB(plan: DBStep[]): D1Database {
  let i = 0;
  return {
    prepare: vi.fn(() => {
      const idx = i++;
      const step = () => plan[idx] || {};
      const s: any = {
        bind: vi.fn(() => s),
        first: vi.fn(async () => step().first ?? null),
        all: vi.fn(async () => step().all ?? { results: [] }),
        run: vi.fn(async () => step().run ?? { meta: { changes: 1 } }),
      };
      return s as D1PreparedStatement;
    }),
    batch: vi.fn(async (stmts: D1PreparedStatement[]) => stmts.map(() => ({ success: true }))),
    exec: vi.fn(),
  } as unknown as D1Database;
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    FILES: {} as R2Bucket,
    ENVIRONMENT: "production",
    SERVICE_INTERNAL_TOKEN: "s2s",
  } as Env;
}

describe("internal room membership lookup", () => {
  const MEMBER_URL = "https://service.example/api/internal/rooms/lobby-lobby-1-room-1-voice/member-ids";

  it("resolves a network namespace to its backing room and lobby members", async () => {
    const db = makeDB([
      { first: { id: "room-1", lobby_id: "lobby-1", vpn_namespace: "lobby-lobby-1-room-1-voice" } },
      { all: { results: [{ user_id: "u1" }, { user_id: "u2" }] } },
    ]);
    const req = new Request(MEMBER_URL, {
      headers: await signInternal("s2s", "GET", MEMBER_URL),
    });
    const resp = await worker.fetch(req, makeEnv(db), {} as ExecutionContext);

    expect(resp.status).toBe(200);
    const body = await resp.json<{
      user_ids: string[];
      room_id: string;
      vpn_namespace: string;
      lobby_id: string;
    }>();
    expect(body).toEqual({
      user_ids: ["u1", "u2"],
      room_id: "room-1",
      vpn_namespace: "lobby-lobby-1-room-1-voice",
      lobby_id: "lobby-1",
    });
  });

  it("rejects a request without signed headers", async () => {
    const resp = await worker.fetch(
      new Request("https://service.example/api/internal/rooms/room-1/member-ids"),
      makeEnv(makeDB([])),
      {} as ExecutionContext,
    );

    expect(resp.status).toBe(403);
  });

  it("rejects the legacy static X-Internal-Token bearer", async () => {
    const resp = await worker.fetch(
      new Request(MEMBER_URL, { headers: { "X-Internal-Token": "s2s" } }),
      makeEnv(makeDB([])),
      {} as ExecutionContext,
    );

    expect(resp.status).toBe(403);
  });

  it("rejects a signature made with the wrong secret", async () => {
    const resp = await worker.fetch(
      new Request(MEMBER_URL, { headers: await signInternal("not-the-secret", "GET", MEMBER_URL) }),
      makeEnv(makeDB([])),
      {} as ExecutionContext,
    );

    expect(resp.status).toBe(403);
  });

  it("rejects a signature for a different path", async () => {
    const headers = await signInternal("s2s", "GET", "https://service.example/api/internal/rooms/other-room/member-ids");
    const resp = await worker.fetch(new Request(MEMBER_URL, { headers }), makeEnv(makeDB([])), {} as ExecutionContext);

    expect(resp.status).toBe(403);
  });

  it("rejects a stale timestamp outside the freshness window", async () => {
    const staleTs = Math.floor(Date.now() / 1000) - INTERNAL_SIG_WINDOW_SEC - 5;
    const headers = await signInternal("s2s", "GET", MEMBER_URL, { ts: staleTs });
    const resp = await worker.fetch(new Request(MEMBER_URL, { headers }), makeEnv(makeDB([])), {} as ExecutionContext);

    expect(resp.status).toBe(403);
  });

  it("rejects a replayed nonce inside the window", async () => {
    const headers = await signInternal("s2s", "GET", MEMBER_URL);
    const db = makeDB([
      { first: { id: "room-1", lobby_id: "lobby-1", vpn_namespace: "lobby-lobby-1-room-1-voice" } },
      { all: { results: [{ user_id: "u1" }] } },
    ]);
    const first = await worker.fetch(new Request(MEMBER_URL, { headers }), makeEnv(db), {} as ExecutionContext);
    expect(first.status).toBe(200);

    const replay = await worker.fetch(new Request(MEMBER_URL, { headers }), makeEnv(makeDB([])), {} as ExecutionContext);
    expect(replay.status).toBe(403);
  });
});

describe("admin init-db", () => {
  it("applies schema as prepared statements in development", async () => {
    const db = makeDB([]);
    const resp = await worker.fetch(
      new Request("https://service.example/api/admin/init-db", { method: "POST" }),
      { ...makeEnv(db), ENVIRONMENT: "development" },
      {} as ExecutionContext,
    );

    expect(resp.status).toBe(200);
    expect(db.batch).toHaveBeenCalledTimes(1);
    const stmts = (db.batch as any).mock.calls[0][0] as D1PreparedStatement[];
    expect(stmts.length).toBeGreaterThan(5);
  });
});
