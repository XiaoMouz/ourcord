import { describe, it, expect, vi } from "vitest";
import { enrollDevice, exchangeDeviceToken, revokeDevice } from "./devices";
import { verifyToken } from "./auth";
import type { Env } from "./types";

const SECRET = "test-secret-1234567890abcdef";
const VALID_WG_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

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

function b64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function makeUserToken(): Promise<string> {
  const data = b64url(JSON.stringify({ sub: "u1", email: "u1@x.io", iat: 1, exp: 9999999999 }));
  return `${data}.${await hmacSign(SECRET, data)}`;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

type DBStep = { first?: unknown; run?: unknown; all?: unknown };

interface CapturingDB {
  db: D1Database;
  binds: unknown[][];
  sqls: string[];
}

function makeCapturingDB(plan: DBStep[]): CapturingDB {
  let i = 0;
  const binds: unknown[][] = [];
  const sqls: string[] = [];
  const db = {
    prepare: vi.fn((sql: string) => {
      const idx = i++;
      sqls.push(sql);
      const step = () => plan[idx] || {};
      const s: any = {
        bind: vi.fn((...args: unknown[]) => {
          binds[idx] = args;
          return s;
        }),
        first: vi.fn(async () => step().first ?? null),
        run: vi.fn(async () => step().run ?? { meta: { changes: 1 } }),
        all: vi.fn(async () => step().all ?? { results: [] }),
      };
      return s as D1PreparedStatement;
    }),
    batch: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;
  return { db, binds, sqls };
}

function makeEnv(db: D1Database): Env {
  return {
    DB: db,
    KV: {} as KVNamespace,
    SIGNAL: {} as DurableObjectNamespace,
    ENVIRONMENT: "production",
    JWT_SECRET: SECRET,
  } as Env;
}

function postJSON(url: string, body: unknown, token?: string): Request {
  const json = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "content-length": String(json.length),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(url, { method: "POST", headers, body: json });
}

describe("enrollDevice", () => {
  it("issues a dt_ secret once and rotates the previous credential atomically", async () => {
    const token = await makeUserToken();
    const cap = makeCapturingDB([
      { first: null }, // ban check (requireAuth)
      {}, // DELETE old credential (inside batch)
      {}, // INSERT new credential (inside batch)
    ]);
    const resp = await enrollDevice(
      postJSON("https://control.example/api/devices/enroll", { public_key: VALID_WG_KEY, name: "vm-a" }, token),
      makeEnv(cap.db),
    );

    expect(resp.status).toBe(201);
    const body = await resp.json<{ id: string; device_token: string; public_key: string }>();
    expect(body.device_token).toMatch(/^dt_[A-Za-z0-9_-]{43}$/);
    expect(body.public_key).toBe(VALID_WG_KEY);

    // Rotation and insert must go through one atomic batch.
    expect(cap.db.batch).toHaveBeenCalledTimes(1);
    expect(cap.sqls[1]).toMatch(/DELETE FROM device_tokens/);
    expect(cap.sqls[2]).toMatch(/INSERT INTO device_tokens/);
    // Only the SHA-256 of the secret is stored, never the plaintext.
    expect(cap.binds[2][3]).toBe(await sha256Hex(body.device_token));
    expect(cap.binds[2]).not.toContain(body.device_token);
  });

  it("rejects a malformed public key", async () => {
    const token = await makeUserToken();
    const cap = makeCapturingDB([{ first: null }]);
    const resp = await enrollDevice(
      postJSON("https://control.example/api/devices/enroll", { public_key: "not-a-key" }, token),
      makeEnv(cap.db),
    );
    expect(resp.status).toBe(400);
  });

  it("requires authentication", async () => {
    const cap = makeCapturingDB([]);
    const resp = await enrollDevice(
      postJSON("https://control.example/api/devices/enroll", { public_key: VALID_WG_KEY }),
      makeEnv(cap.db),
    );
    expect(resp.status).toBe(401);
  });
});

describe("exchangeDeviceToken", () => {
  const DEVICE_SECRET = "dt_" + "a".repeat(43);

  it("exchanges a live credential for a verifiable short-lived JWT", async () => {
    const cap = makeCapturingDB([
      { first: { id: "dev-1", user_id: "u1", revoked_at: null, email: "u1@x.io" } }, // hash lookup
      { first: null }, // ban check
      {}, // last_used update
    ]);
    const resp = await exchangeDeviceToken(
      postJSON("https://control.example/api/auth/device", { device_token: DEVICE_SECRET }),
      makeEnv(cap.db),
    );

    expect(resp.status).toBe(200);
    const body = await resp.json<{ token: string; user_id: string; expires_at: number }>();
    expect(body.user_id).toBe("u1");
    // Lookup key must be the SHA-256 of the presented secret.
    expect(cap.binds[0][0]).toBe(await sha256Hex(DEVICE_SECRET));
    // The issued JWT verifies against the control secret and matches the user.
    const claims = await verifyToken(body.token, SECRET);
    expect(claims?.sub).toBe("u1");
    expect(body.expires_at).toBe(claims?.exp);
  });

  it("rejects an unknown credential", async () => {
    const cap = makeCapturingDB([{ first: null }]);
    const resp = await exchangeDeviceToken(
      postJSON("https://control.example/api/auth/device", { device_token: DEVICE_SECRET }),
      makeEnv(cap.db),
    );
    expect(resp.status).toBe(401);
  });

  it("rejects a revoked credential", async () => {
    const cap = makeCapturingDB([
      { first: { id: "dev-1", user_id: "u1", revoked_at: 1234, email: "u1@x.io" } },
    ]);
    const resp = await exchangeDeviceToken(
      postJSON("https://control.example/api/auth/device", { device_token: DEVICE_SECRET }),
      makeEnv(cap.db),
    );
    expect(resp.status).toBe(401);
  });

  it("rejects a banned user's credential", async () => {
    const cap = makeCapturingDB([
      { first: { id: "dev-1", user_id: "u1", revoked_at: null, email: "u1@x.io" } },
      { first: { id: "ban-1" } }, // active ban row
    ]);
    const resp = await exchangeDeviceToken(
      postJSON("https://control.example/api/auth/device", { device_token: DEVICE_SECRET }),
      makeEnv(cap.db),
    );
    expect(resp.status).toBe(401);
  });

  it("rejects a token without the dt_ prefix without touching the DB", async () => {
    const cap = makeCapturingDB([]);
    const resp = await exchangeDeviceToken(
      postJSON("https://control.example/api/auth/device", { device_token: "eyJhbGciOi..." }),
      makeEnv(cap.db),
    );
    expect(resp.status).toBe(401);
    expect(cap.db.prepare).not.toHaveBeenCalled();
  });
});

describe("revokeDevice", () => {
  it("revokes an owned device", async () => {
    const token = await makeUserToken();
    const cap = makeCapturingDB([
      { first: null }, // ban check
      { run: { meta: { changes: 1 } } },
    ]);
    const resp = await revokeDevice(
      new Request("https://control.example/api/devices/dev-1", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(cap.db),
      "dev-1",
    );
    expect(resp.status).toBe(200);
    expect(cap.sqls[1]).toMatch(/UPDATE device_tokens SET revoked_at/);
    expect(cap.binds[1].slice(1)).toEqual(["dev-1", "u1"]);
  });

  it("404s for a device the caller does not own", async () => {
    const token = await makeUserToken();
    const cap = makeCapturingDB([
      { first: null }, // ban check
      { run: { meta: { changes: 0 } } },
    ]);
    const resp = await revokeDevice(
      new Request("https://control.example/api/devices/dev-9", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(cap.db),
      "dev-9",
    );
    expect(resp.status).toBe(404);
  });
});
