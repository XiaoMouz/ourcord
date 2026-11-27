import { describe, it, expect, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { reportPeerConnectivity } from "./peers";
import type { Env } from "./types";

// Drives the REAL arbitration SQL (CONNECTIVITY_ACCEPT_WHERE) through the real
// handler against real SQLite with the real migrations applied — the upsert
// predicate is the heart of sequence arbitration and regex assertions on the
// statement text cannot prove its semantics. D1 is SQLite-compatible, so a
// thin D1 shim over node:sqlite is a faithful executor.

const SECRET = "test-secret-1234567890abcdef";
const A_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const B_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
const NET = "lobby-l1-r1-voice";

async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const b = new Uint8Array(sig);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makeToken(sub: string): Promise<string> {
  const data = btoa(JSON.stringify({ sub, email: `${sub}@x.io`, iat: 1, exp: 9999999999 }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${data}.${await hmacSign(SECRET, data)}`;
}

// Thin D1Database adapter over node:sqlite — just enough surface for
// reportPeerConnectivity (prepare/bind/first/run/all + batch).
function d1Over(db: DatabaseSync): D1Database {
  const stmt = (sql: string) => {
    let params: unknown[] = [];
    const s: any = {
      bind: (...args: unknown[]) => {
        params = args;
        return s;
      },
      first: async () => (db.prepare(sql).get(...params) as unknown) ?? null,
      run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
      all: async () => ({ results: db.prepare(sql).all(...params) }),
      __exec: () => db.prepare(sql).run(...params),
    };
    return s;
  };
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: any[]) => stmts.map((st) => ({ meta: { changes: Number(st.__exec().changes) } })),
    exec: async (sql: string) => db.exec(sql),
  } as unknown as D1Database;
}

function report(
  token: string,
  selfKey: string,
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const json = JSON.stringify({ network_id: NET, ...body });
  return reportPeerConnectivity(
    new Request("https://control.example/api/peers/connectivity", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Peer-Public-Key": selfKey,
        "content-type": "application/json",
        "content-length": String(json.length),
      },
      body: json,
    }),
    env,
  );
}

function edge(db: DatabaseSync, src: string, dst: string) {
  return db
    .prepare(
      `SELECT ice_direct, wg_reachable, transport, reason, quality, reporter_public_key, reporter_epoch, seq
       FROM peer_connectivity WHERE network_id = ? AND src_public_key = ? AND dst_public_key = ?`,
    )
    .get(NET, src, dst) as any;
}

describe("connectivity sequence arbitration (real SQL)", () => {
  let db: DatabaseSync;
  let env: Env;
  let tokenA: string;
  let tokenB: string;

  beforeEach(async () => {
    db = new DatabaseSync(":memory:");
    const dir = join(__dirname, "..", "migrations");
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      db.exec(readFileSync(join(dir, f), "utf8"));
    }
    db.exec(`INSERT INTO users (id, email, display_name, created_at) VALUES
               ('u1','u1@x.io','U1',0), ('u2','u2@x.io','U2',0)`);
    db.exec(`INSERT INTO peers (id, user_id, public_key, name, platform, last_seen, ip4, ip6, derp_node_key)
             VALUES ('p1','u1','${A_KEY}','a','linux',0,'198.18.0.2','fd::2',''),
                    ('p2','u2','${B_KEY}','b','linux',0,'198.18.0.3','fd::3','')`);
    // Arbitration runs after the peers acquired room leases via config refresh.
    const now = Math.floor(Date.now() / 1000);
    for (const key of [A_KEY, B_KEY]) {
      db.prepare("INSERT INTO peer_presence(public_key, network_id, last_seen) VALUES (?,?,?)").run(key, NET, now);
    }
    env = { DB: d1Over(db), KV: {} as KVNamespace, SIGNAL: {} as DurableObjectNamespace, ENVIRONMENT: "production", JWT_SECRET: SECRET } as Env;
    tokenA = await makeToken("u1");
    tokenB = await makeToken("u2");
  });

  it("same epoch: higher seq wins, stale lower seq is rejected", async () => {
    // A upgrades to ice at seq 2…
    expect((await report(tokenA, A_KEY, {
      peer_public_key: B_KEY, ice_direct: true, wg_reachable: true,
      source: "ice", reporter_epoch: "epochA_000001", seq: 2, observed_at: 1000,
    }, env)).status).toBe(200);
    // …then a reordered baseline generated earlier (seq 1) lands late.
    expect((await report(tokenA, A_KEY, {
      peer_public_key: B_KEY, ice_direct: false, wg_reachable: true, reason: "derp-baseline",
      source: "derp_baseline", reporter_epoch: "epochA_000001", seq: 1, observed_at: 999,
    }, env)).status).toBe(200);

    const row = edge(db, A_KEY, B_KEY);
    expect(row.transport).toBe("ice");
    expect(row.seq).toBe(2);
  });

  it("epoch rotation (network re-enter) lands fresh reports despite a higher stored seq", async () => {
    // Old session left the edge at seq 40.
    await report(tokenA, A_KEY, {
      peer_public_key: B_KEY, ice_direct: true, wg_reachable: true,
      source: "ice", reporter_epoch: "epochA_000001", seq: 40, observed_at: 1000,
    }, env);
    // Daemon re-enters the network: new epoch, counters restart at 1. This is
    // the regression the daemon-side epoch rotation fixes — with the old epoch
    // this seq=1 report would be silently dropped until seq passed 40.
    await report(tokenA, A_KEY, {
      peer_public_key: B_KEY, ice_direct: false, wg_reachable: true, reason: "derp-baseline",
      source: "derp_baseline", reporter_epoch: "epochA_000002", seq: 1, observed_at: 1100,
    }, env);

    const row = edge(db, A_KEY, B_KEY);
    expect(row.reporter_epoch).toBe("epochA_000002");
    expect(row.transport).toBe("derp");
    expect(row.seq).toBe(1);
  });

  it("keeps opposite directed observations independent", async () => {
    // A and B observe their own outgoing directions independently.
    await report(tokenA, A_KEY, {
      peer_public_key: B_KEY, ice_direct: true, wg_reachable: true,
      source: "ice", reporter_epoch: "epochA_000001", seq: 5, observed_at: 1000,
    }, env);
    // B reports mere derp-baseline moments later for B→A.
    await report(tokenB, B_KEY, {
      peer_public_key: A_KEY, ice_direct: false, wg_reachable: true, reason: "derp-baseline",
      source: "derp_baseline", reporter_epoch: "epochB_000001", seq: 1, observed_at: 1005,
    }, env);

    // A→B remains A's direct observation.
    const ab = edge(db, A_KEY, B_KEY);
    expect(ab.transport).toBe("ice");
    expect(ab.reporter_public_key).toBe(A_KEY);
    // B→A is B's independent DERP observation, not a mirrored A report.
    const ba = edge(db, B_KEY, A_KEY);
    expect(ba.transport).toBe("derp");
    expect(ba.reporter_public_key).toBe(B_KEY);
  });

  it("records an unreachable verdict only for the reporting direction", async () => {
    await report(tokenA, A_KEY, {
      peer_public_key: B_KEY, ice_direct: true, wg_reachable: true,
      source: "ice", reporter_epoch: "epochA_000001", seq: 5, observed_at: 1000,
    }, env);
    await report(tokenB, B_KEY, {
      peer_public_key: A_KEY, ice_direct: false, wg_reachable: false, reason: "unreachable",
      source: "reachability", reporter_epoch: "epochB_000001", seq: 1, observed_at: 1001,
    }, env);

    expect(edge(db, A_KEY, B_KEY).wg_reachable).toBe(1);
    expect(edge(db, B_KEY, A_KEY).wg_reachable).toBe(0);
  });

  it("a later same-session derp-baseline never clobbers a standing unreachable verdict", async () => {
    await report(tokenA, A_KEY, {
      peer_public_key: B_KEY, ice_direct: false, wg_reachable: false, reason: "unreachable",
      source: "reachability", reporter_epoch: "epochA_000001", seq: 3, observed_at: 1000,
    }, env);
    await report(tokenA, A_KEY, {
      peer_public_key: B_KEY, ice_direct: false, wg_reachable: true, reason: "derp-baseline",
      source: "derp_baseline", reporter_epoch: "epochA_000001", seq: 4, observed_at: 1010,
    }, env);

    const row = edge(db, A_KEY, B_KEY);
    expect(row.wg_reachable).toBe(0);
    expect(row.reason).toBe("unreachable");
    // derp-recovery (the reachability monitor's explicit verdict) DOES clear it.
    await report(tokenA, A_KEY, {
      peer_public_key: B_KEY, ice_direct: false, wg_reachable: true, reason: "derp-recovery",
      source: "reachability", reporter_epoch: "epochA_000001", seq: 5, observed_at: 1020,
    }, env);
    expect(edge(db, A_KEY, B_KEY).wg_reachable).toBe(1);
  });

  it("legacy unsequenced reports cannot regress a sequenced row", async () => {
    await report(tokenA, A_KEY, {
      peer_public_key: B_KEY, ice_direct: true, wg_reachable: true,
      source: "ice", reporter_epoch: "epochA_000001", seq: 2, observed_at: 1000,
    }, env);
    // Legacy daemon (no epoch/seq) reports baseline.
    await report(tokenA, A_KEY, {
      peer_public_key: B_KEY, ice_direct: false, wg_reachable: true, reason: "derp-baseline",
    }, env);

    expect(edge(db, A_KEY, B_KEY).transport).toBe("ice");
  });

  it("stores path-flap telemetry on the reporting edge", async () => {
    await report(tokenA, A_KEY, {
      peer_public_key: B_KEY, ice_direct: true, wg_reachable: true,
      source: "ice", reporter_epoch: "epochA_000001", seq: 1, observed_at: 1000,
      path_transitions: 7, flapping: true,
    }, env);
    const row = db
      .prepare(`SELECT flap_count, flapping FROM peer_connectivity WHERE network_id=? AND src_public_key=? AND dst_public_key=?`)
      .get(NET, A_KEY, B_KEY) as any;
    expect(row.flap_count).toBe(7);
    expect(row.flapping).toBe(1);

    // A malformed value never drops the report: the edge still updates, flap
    // fields fall back to safe defaults.
    await report(tokenA, A_KEY, {
      peer_public_key: B_KEY, ice_direct: true, wg_reachable: true,
      source: "ice", reporter_epoch: "epochA_000001", seq: 2, observed_at: 1001,
      path_transitions: "nonsense", flapping: "yes",
    }, env);
    const row2 = db
      .prepare(`SELECT flap_count, flapping, seq FROM peer_connectivity WHERE network_id=? AND src_public_key=? AND dst_public_key=?`)
      .get(NET, A_KEY, B_KEY) as any;
    expect(row2.seq).toBe(2);
    expect(row2.flap_count).toBe(0);
    expect(row2.flapping).toBe(0);
  });
});
