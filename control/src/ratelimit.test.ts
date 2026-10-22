import { describe, it, expect, vi } from "vitest";
import { checkRateLimit } from "./ratelimit";
import worker from "./index";
import type { Env } from "./types";

function setup(success = true) {
  const limit = vi.fn(async (_options: RateLimitOptions) => ({ success }));
  const env = {
    ENVIRONMENT: "production", RATE_LIMIT_5: { limit },
    KV: { get: vi.fn(), put: vi.fn() },
  } as unknown as Env;
  return { env, limit };
}
function req(ip?: string) {
  return new Request("https://example.test/", { headers: ip ? { "cf-connecting-ip": ip } : {} });
}

describe("native rate limiting", () => {
  it("uses the configured binding without any KV operations", async () => {
    const { env, limit } = setup();
    expect(await checkRateLimit(req("1.2.3.4"), env, "otp", 5, 60)).toBeNull();
    expect(limit).toHaveBeenCalledWith({ key: "otp:1.2.3.4" });
    expect(env.KV.get).not.toHaveBeenCalled();
    expect(env.KV.put).not.toHaveBeenCalled();
  });
  it("returns a retryable 429 when the binding rejects", async () => {
    const { env } = setup(false);
    const response = await checkRateLimit(req(), env, "otp", 5, 60);
    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBe("60");
  });
  it("isolates buckets and IPs, including the local anonymous fallback", async () => {
    const { env, limit } = setup();
    await checkRateLimit(req(), env, "a", 5, 60);
    await checkRateLimit(req("1.2.3.4"), env, "a", 5, 60);
    await checkRateLimit(req("1.2.3.4"), env, "b", 5, 60);
    expect(limit.mock.calls.map(([arg]) => arg)).toEqual([
      { key: "a:anon" }, { key: "a:1.2.3.4" }, { key: "b:1.2.3.4" },
    ]);
  });
  it("fails closed on a missing production binding", async () => {
    const { env } = setup();
    delete env.RATE_LIMIT_5;
    expect((await checkRateLimit(req(), env, "a", 5, 60))?.status).toBe(503);
    env.ENVIRONMENT = "development";
    expect(await checkRateLimit(req(), env, "a", 5, 60)).toBeNull();
  });
});

describe("expensive route gates", () => {
  it.each([
    ["GET", "/api/auth/oauth/github", 20],
    ["GET", "/api/auth/desktop/oauth/github", 20],
    ["GET", "/api/peers/config", 120],
    ["GET", "/api/control/status", 60],
    ["POST", "/api/relay/register", 120],
  ] as const)("blocks %s %s before storage or auth work", async (method, path, cap) => {
    const prepare = vi.fn();
    const env = {
      ENVIRONMENT: "production", DB: { prepare },
      [`RATE_LIMIT_${cap}`]: { limit: vi.fn(async () => ({ success: false })) },
    } as unknown as Env;
    const response = await worker.fetch(new Request(`https://example.test${path}`, { method }), env, {} as ExecutionContext);
    expect(response.status).toBe(429);
    expect(prepare).not.toHaveBeenCalled();
  });
});
