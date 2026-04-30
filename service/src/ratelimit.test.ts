import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { checkRateLimit } from "./ratelimit";
import type { Env } from "./types";

function makeKV() {
  const store = new Map<string, { value: string; exp?: number }>();
  return {
    get: vi.fn(async (k: string) => {
      const v = store.get(k);
      if (!v) return null;
      if (v.exp && Date.now() / 1000 > v.exp) {
        store.delete(k);
        return null;
      }
      return v.value;
    }),
    put: vi.fn(async (k: string, v: string, opts?: { expirationTtl?: number }) => {
      store.set(k, {
        value: v,
        exp: opts?.expirationTtl ? Date.now() / 1000 + opts.expirationTtl : undefined,
      });
    }),
    delete: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    KV: makeKV(),
    SIGNAL: {} as DurableObjectNamespace,
    ENVIRONMENT: "production",
    ...overrides,
  } as Env;
}

function req(ip?: string): Request {
  const headers: Record<string, string> = {};
  if (ip) headers["cf-connecting-ip"] = ip;
  return new Request("https://control.example/anything", { method: "POST", headers });
}

describe("checkRateLimit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("first request under limit returns null (allowed)", async () => {
    const env = makeEnv();
    const r = await checkRateLimit(req("1.1.1.1"), env, "b", 3, 60);
    expect(r).toBeNull();
  });

  it("after limit requests returns 429 with Retry-After header", async () => {
    const env = makeEnv();
    for (let i = 0; i < 3; i++) {
      const ok = await checkRateLimit(req("1.1.1.1"), env, "b", 3, 60);
      expect(ok).toBeNull();
    }
    const blocked = await checkRateLimit(req("1.1.1.1"), env, "b", 3, 60);
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
    expect(blocked!.headers.get("Retry-After")).not.toBeNull();
    const body = await blocked!.json<{ error: string; retry_after: number }>();
    expect(body.error).toMatch(/rate limit/i);
  });

  it("different IPs counted separately", async () => {
    const env = makeEnv();
    for (let i = 0; i < 3; i++) {
      expect(await checkRateLimit(req("1.1.1.1"), env, "b", 3, 60)).toBeNull();
    }
    // First IP exhausted, second IP still fresh.
    expect(await checkRateLimit(req("1.1.1.1"), env, "b", 3, 60)).not.toBeNull();
    expect(await checkRateLimit(req("2.2.2.2"), env, "b", 3, 60)).toBeNull();
  });

  it("after window expires counter resets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
    const env = makeEnv();
    for (let i = 0; i < 3; i++) {
      expect(await checkRateLimit(req("1.1.1.1"), env, "b", 3, 60)).toBeNull();
    }
    expect(await checkRateLimit(req("1.1.1.1"), env, "b", 3, 60)).not.toBeNull();
    // Advance well past window + TTL buffer so KV entry is expired.
    vi.setSystemTime(new Date("2025-01-01T00:05:00Z"));
    expect(await checkRateLimit(req("1.1.1.1"), env, "b", 3, 60)).toBeNull();
  });

  it("missing cf-connecting-ip falls back to anon bucket but still works", async () => {
    const env = makeEnv();
    expect(await checkRateLimit(req(), env, "b", 2, 60)).toBeNull();
    expect(await checkRateLimit(req(), env, "b", 2, 60)).toBeNull();
    const blocked = await checkRateLimit(req(), env, "b", 2, 60);
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
  });

  it("KV unavailable degrades open (returns null)", async () => {
    const env = makeEnv({ KV: undefined as unknown as KVNamespace });
    for (let i = 0; i < 100; i++) {
      expect(await checkRateLimit(req("1.1.1.1"), env, "b", 1, 60)).toBeNull();
    }
  });
});
