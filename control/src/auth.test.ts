import { describe, it, expect, vi, afterEach } from "vitest";
import {
  signToken,
  verifyToken,
  makeToken,
  generateOTP,
  generateId,
  requireAuth,
  isUserBanned,
} from "./auth";
import { verifyOTP } from "./authHandler";
import type { Env } from "./types";

const SECRET = "test-secret-do-not-reuse";

describe("signToken / verifyToken", () => {
  it("round-trips a valid payload", async () => {
    const payload = makeToken("user-1", "alice@example.com");
    const tok = await signToken(payload, SECRET);
    const back = await verifyToken(tok, SECRET);
    expect(back).not.toBeNull();
    expect(back!.sub).toBe("user-1");
    expect(back!.email).toBe("alice@example.com");
  });

  it("returns null for wrong secret", async () => {
    const tok = await signToken(makeToken("u", "e@e"), SECRET);
    expect(await verifyToken(tok, "wrong-secret")).toBeNull();
  });

  it("returns null for tampered payload", async () => {
    const tok = await signToken(makeToken("u", "e@e"), SECRET);
    const [data, sig] = tok.split(".");
    // Flip a character in the payload but keep the signature.
    const tampered = data.slice(0, -1) + (data.endsWith("a") ? "b" : "a") + "." + sig;
    expect(await verifyToken(tampered, SECRET)).toBeNull();
  });

  it("returns null for malformed token", async () => {
    expect(await verifyToken("not-a-token", SECRET)).toBeNull();
    expect(await verifyToken("only.one.dot.too.many", SECRET)).toBeNull();
  });

  it("returns null for expired payload", async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const tok = await signToken(
      { sub: "u", email: "e@e", iat: past - 100, exp: past },
      SECRET,
    );
    expect(await verifyToken(tok, SECRET)).toBeNull();
  });

  it("makeToken sets exp 1 hour in the future (X1)", () => {
    const t = makeToken("x", "y@z");
    const expectedExp = Math.floor(Date.now() / 1000) + 3600;
    expect(t.exp - t.iat).toBe(3600);
    expect(Math.abs(t.exp - expectedExp)).toBeLessThan(5);
  });
});

describe("generateOTP", () => {
  it("returns a 6-character zero-padded numeric string", () => {
    for (let i = 0; i < 50; i++) {
      const otp = generateOTP();
      expect(otp).toMatch(/^\d{6}$/);
    }
  });

  it("is not deterministic", () => {
    const otps = new Set(Array.from({ length: 20 }, () => generateOTP()));
    expect(otps.size).toBeGreaterThan(1);
  });

  // X2: rejection sampling should still always produce a valid 6-digit code
  // across many draws — no off-by-one, no NaN, no leading-space artefacts.
  it("is always exactly 6 digits across 1000 draws (X2 rejection sampling)", () => {
    for (let i = 0; i < 1000; i++) {
      const otp = generateOTP();
      expect(otp).toHaveLength(6);
      expect(otp).toMatch(/^[0-9]{6}$/);
    }
  });
});

describe("generateId", () => {
  it("returns a 32-char lowercase hex string", () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is unique across many invocations", () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateId()));
    expect(ids.size).toBe(200);
  });
});

// --- X1: ban enforcement on requireAuth + JWT issuance --------------------

// Tiny D1 stub: only models the SELECT used by isUserBanned. `bannedIds` is
// the set of user ids currently considered banned (mimics rows in `bans`
// with target_type='user' and unexpired). The stub mirrors D1's
// prepare().bind().first() shape closely enough for the SUT, but no more.
function makeBanDB(bannedIds: Set<string>): D1Database {
  const stmt = (sql: string) => ({
    bind: (...args: unknown[]) => ({
      first: async <T = unknown>() => {
        if (/FROM bans/i.test(sql) && /target_type = 'user'/i.test(sql)) {
          const targetId = String(args[0]);
          return bannedIds.has(targetId)
            ? ({ id: "ban-" + targetId } as unknown as T)
            : null;
        }
        // verifyOTP path: SELECT id, email, banned_at FROM users WHERE email = ?
        if (/FROM users/i.test(sql)) return null as T;
        return null as T;
      },
      run: async () => ({ success: true } as unknown),
      all: async () => ({ results: [] } as unknown),
    }),
  });
  return { prepare: (sql: string) => stmt(sql) } as unknown as D1Database;
}

function makeKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    delete: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

function makeEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    KV: makeKV(),
    SIGNAL: {} as DurableObjectNamespace,
    ENVIRONMENT: "production",
    JWT_SECRET: "test-secret-do-not-reuse-and-at-least-16-bytes",
    ...overrides,
  } as Env;
}

async function authedRequest(userId: string, email: string, secret: string): Promise<Request> {
  const tok = await signToken(makeToken(userId, email), secret);
  return new Request("https://control.example/api/anything", {
    headers: { Authorization: `Bearer ${tok}` },
  });
}

describe("isUserBanned (D1 stub sanity)", () => {
  it("returns true for a banned id and false otherwise", async () => {
    const db = makeBanDB(new Set(["banned-user"]));
    expect(await isUserBanned("banned-user", db)).toBe(true);
    expect(await isUserBanned("good-user", db)).toBe(false);
  });
});

describe("requireAuth ban enforcement (X1)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns 401 Unauthorized for a banned user (does not leak ban)", async () => {
    const env = makeEnv(makeBanDB(new Set(["banned-user"])));
    const req = await authedRequest("banned-user", "b@e", env.JWT_SECRET!);
    const res = await requireAuth(req, env);
    expect(res).toBeInstanceOf(Response);
    const r = res as Response;
    expect(r.status).toBe(401);
    const body = await r.json<{ error: string }>();
    expect(body.error).toBe("Unauthorized");
  });

  it("passes through the token payload for a non-banned user", async () => {
    const env = makeEnv(makeBanDB(new Set()));
    const req = await authedRequest("good-user", "g@e", env.JWT_SECRET!);
    const res = await requireAuth(req, env);
    expect(res).not.toBeInstanceOf(Response);
    const payload = res as Awaited<ReturnType<typeof verifyToken>> & object;
    expect((payload as { sub: string }).sub).toBe("good-user");
  });
});

describe("JWT issuance ban enforcement via verifyOTP (X1)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects a banned existing user with 403 'User is banned' and issues no token", async () => {
    // Stub D1 so that:
    //   - the users SELECT returns an existing user with this email/id, and
    //   - the bans SELECT marks that user id as banned.
    const bannedId = "user-banned-1";
    const db = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async <T = unknown>() => {
            if (/FROM bans/i.test(sql)) {
              return args[0] === bannedId
                ? ({ id: "ban-row" } as unknown as T)
                : null;
            }
            if (/FROM users/i.test(sql)) {
              return {
                id: bannedId,
                email: String(args[0]),
                banned_at: null,
              } as unknown as T;
            }
            return null as T;
          },
          run: async () => ({ success: true }),
        }),
      }),
    } as unknown as D1Database;

    const env = makeEnv(db, { ENVIRONMENT: "production" });
    // Pre-seed a matching OTP in KV so verifyOTP reaches the ban check.
    await env.KV.put("otp:banned@example.com", "123456");

    const req = new Request("https://control.example/api/auth/otp/verify", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "100" },
      body: JSON.stringify({ email: "banned@example.com", otp: "123456" }),
    });
    const res = await verifyOTP(req, env);
    expect(res.status).toBe(403);
    const body = await res.json<{ error?: string; token?: string }>();
    expect(body.error).toBe("User is banned");
    expect(body.token).toBeUndefined();
  });
});
