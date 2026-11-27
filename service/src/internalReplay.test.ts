import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "./index";
import { hmacSign } from "./auth";
import type { Env } from "./types";

const URL = "https://service.test/api/internal/rooms/R1/member-ids";
const SECRET = "internal-replay-test-secret";
const START = 1_800_000_000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("internal request replay protection (real SQLite and worker routes)", () => {
  let db: DatabaseSync;
  let env: Env;
  let beforeInsert: (() => Promise<void>) | undefined;
  let inserts: number;
  let memberReads: number;

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(START * 1000);
    vi.spyOn(Math, "random").mockReturnValue(1);
    db = new DatabaseSync(":memory:");
    const directory = join(__dirname, "../migrations");
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      db.exec(readFileSync(join(directory, file), "utf8"));
    }
    db.exec(`
      INSERT INTO lobbies VALUES ('L1', 'test', 'u1', NULL, 1);
      INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES ('L1','u1','owner',1);
      INSERT INTO rooms(id,lobby_id,name) VALUES ('R1','L1','general');
    `);
    inserts = memberReads = 0;
    beforeInsert = undefined;
    env = {
      ENVIRONMENT: "production", SERVICE_INTERNAL_TOKEN: SECRET,
      DB: {
        prepare(sql: string) {
          let params: unknown[] = [];
          const statement = {
            bind(...values: unknown[]) { params = values; return statement; },
            async first() { return db.prepare(sql).get(...params) ?? null; },
            async all() {
              if (sql.includes("lobby_members")) memberReads++;
              return { results: db.prepare(sql).all(...params) };
            },
            async run() {
              if (sql.startsWith("INSERT OR IGNORE INTO internal_nonces")) {
                inserts++;
                await beforeInsert?.();
              }
              return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } };
            },
          };
          return statement;
        },
      } as unknown as D1Database,
    } as Env;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  async function signed(ts = START) {
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const sig = await hmacSign(SECRET, `${ts}\n${nonce}\nGET\n/api/internal/rooms/R1/member-ids`);
    return { "X-Internal-Ts": String(ts), "X-Internal-Nonce": nonce, "X-Internal-Sig": sig };
  }

  function call(headers: Record<string, string>) {
    return worker.fetch(new Request(URL, { headers }), env, {} as ExecutionContext);
  }

  function failNonceWrites() {
    db.exec(`CREATE TRIGGER fail_nonce BEFORE INSERT ON internal_nonces
      BEGIN SELECT RAISE(FAIL, 'nonce persistence unavailable'); END`);
  }

  it.each([false, true])("admits only one concurrent copy with nonce write failure=%s", async (fail) => {
    if (fail) failNonceWrites();
    const entered = deferred();
    const replayEntered = deferred();
    const release = deferred();
    beforeInsert = async () => {
      (inserts === 1 ? entered : replayEntered).resolve();
      await release.promise;
    };
    const headers = await signed();
    const first = call(headers);
    await Promise.race([entered.promise, first.then(() => { throw new Error("first request skipped nonce write"); })]);
    const replay = call(headers);
    try {
      // The fixed fast rejection returns without entering D1; the baseline
      // reaches a second INSERT. Both schedules release the first request.
      await Promise.race([replayEntered.promise, replay]);
    } finally {
      release.resolve();
    }
    expect((await first).status).toBe(200);
    expect((await replay).status).toBe(403);
    expect(memberReads).toBe(1);
    expect(inserts).toBe(1);
  });

  it.each([false, true])("rejects replay at the inclusive freshness boundary with nonce write failure=%s", async (fail) => {
    if (fail) failNonceWrites();
    const headers = await signed(START + 90);
    expect((await call(headers)).status).toBe(200);
    vi.mocked(Date.now).mockReturnValue((START + 180) * 1000);
    // An unrelated valid request selects the real opportunistic DELETE.
    vi.mocked(Math.random).mockReturnValue(0);
    expect((await call(await signed(START + 180))).status).toBe(200);
    expect((await call(headers)).status).toBe(403);
    if (!fail) {
      vi.resetModules();
      const freshWorker = (await import("./index")).default;
      expect((await freshWorker.fetch(new Request(URL, { headers }), env, {} as ExecutionContext)).status)
        .toBe(403);
    }
    expect(memberReads).toBe(2);
  });

  it("keeps D1 authoritative when a fresh isolate has no local nonce cache", async () => {
    const headers = await signed();
    expect((await call(headers)).status).toBe(200);
    vi.resetModules();
    const freshWorker = (await import("./index")).default;
    const replay = await freshWorker.fetch(new Request(URL, { headers }), env, {} as ExecutionContext);
    expect(replay.status).toBe(403);
    expect(memberReads).toBe(1);
    expect(inserts).toBe(2);
  });

  it("does not let invalid signatures reserve a valid request's nonce", async () => {
    const headers = await signed();
    expect((await call({ ...headers, "X-Internal-Sig": "invalid" })).status).toBe(403);
    expect(inserts).toBe(0);
    expect((await call(headers)).status).toBe(200);
    expect((await call(headers)).status).toBe(403);
    expect(memberReads).toBe(1);
  });

  it("prunes nonces only after their signatures can no longer be accepted", async () => {
    const headers = await signed(START + 90);
    expect((await call(headers)).status).toBe(200);
    vi.mocked(Date.now).mockReturnValue((START + 181) * 1000);
    vi.mocked(Math.random).mockReturnValue(0);
    expect((await call(await signed(START + 181))).status).toBe(200);
    expect(db.prepare("SELECT nonce FROM internal_nonces WHERE nonce = ?").get(headers["X-Internal-Nonce"]))
      .toBeUndefined();
    expect((await call(headers)).status).toBe(403);
    expect(memberReads).toBe(2);
  });
});
