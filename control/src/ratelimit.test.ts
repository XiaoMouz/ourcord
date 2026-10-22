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

describe("desktop magic confirmation storage gate", () => {
  function confirmation(token = "a".repeat(64)) {
    return new Request("https://control.test/api/auth/desktop/magic/confirm", {
      method: "POST", headers: { "CF-Connecting-IP": "192.0.2.1" },
      body: new URLSearchParams({ token }),
    });
  }
  function confirmationEnv() {
    let attempts = 0;
    const limit = vi.fn(async () => ({ success: ++attempts <= 20 }));
    const get = vi.fn(async (): Promise<string | null> => null);
    const remove = vi.fn(async () => {});
    const prepare = vi.fn();
    const env = {
      ENVIRONMENT: "production", RATE_LIMIT_20: { limit },
      KV: { get, delete: remove }, DB: { prepare },
    } as unknown as Env;
    return { env, limit, get, remove, prepare };
  }

  it("bounds unauthenticated random-token probes before KV access", async () => {
    const { env, limit, get, remove, prepare } = confirmationEnv();
    const statuses = [];
    for (let index = 0; index < 32; index++) {
      statuses.push((await worker.fetch(
        confirmation(index.toString(16).padStart(64, "0")), env, {} as ExecutionContext,
      )).status);
    }
    expect({
      invalid: statuses.filter((status) => status === 400).length,
      throttled: statuses.filter((status) => status === 429).length,
      kvReads: get.mock.calls.length,
      kvDeletes: remove.mock.calls.length,
    }).toEqual({ invalid: 20, throttled: 12, kvReads: 20, kvDeletes: 0 });
    expect(limit).toHaveBeenCalledTimes(32);
    expect(get).toHaveBeenCalledTimes(20);
    expect(remove).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not delete nonexistent or already-consumed capabilities", async () => {
    const { env, get, remove } = confirmationEnv();
    expect((await worker.fetch(confirmation(), env, {} as ExecutionContext)).status).toBe(400);
    expect(get).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });

  it("fails closed before storage access when the production limiter is missing", async () => {
    const { env, get, remove } = confirmationEnv();
    delete env.RATE_LIMIT_20;
    expect((await worker.fetch(confirmation(), env, {} as ExecutionContext)).status).toBe(503);
    expect(get).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("rejects an exhausted IP before parsing its form or consuming its valid token", async () => {
    const { env, limit, get, remove } = confirmationEnv();
    limit.mockResolvedValue({ success: false });
    get.mockResolvedValue(JSON.stringify({ email: "alice@example.test", challenge: "A".repeat(43) }));
    const request = confirmation();
    const parse = vi.spyOn(request, "formData");
    const response = await worker.fetch(request, env, {} as ExecutionContext);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(parse).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("keeps GET previews free of token consumption and confirmation quota", async () => {
    const { env, limit, get, remove } = confirmationEnv();
    limit.mockResolvedValue({ success: false });
    const response = await worker.fetch(new Request(
      `https://control.test/api/auth/desktop/magic/confirm?token=${"a".repeat(64)}`,
    ), env, {} as ExecutionContext);
    expect(response.status).toBe(200);
    expect(limit).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
});
