import { describe, it, expect, vi } from "vitest";
import worker from "./index";
import type { Env } from "./types";

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
  it("resolves a network namespace to its backing room and lobby members", async () => {
    const db = makeDB([
      { first: { id: "room-1", lobby_id: "lobby-1", vpn_namespace: "lobby-lobby-1-room-1-voice" } },
      { all: { results: [{ user_id: "u1" }, { user_id: "u2" }] } },
    ]);
    const req = new Request("https://service.example/api/internal/rooms/lobby-lobby-1-room-1-voice/member-ids", {
      headers: { "X-Internal-Token": "s2s" },
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

  it("rejects missing or wrong internal token", async () => {
    const resp = await worker.fetch(
      new Request("https://service.example/api/internal/rooms/room-1/member-ids"),
      makeEnv(makeDB([])),
      {} as ExecutionContext,
    );

    expect(resp.status).toBe(403);
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
