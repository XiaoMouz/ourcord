import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { requestOTP } from "./authHandler";
import type { Env } from "./types";

// Minimal in-memory KV stub. Only the methods we use.
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

function postOTP(email: string): Request {
  return new Request("https://control.example/api/auth/otp/request", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "100" },
    body: JSON.stringify({ email }),
  });
}

describe("sendOTPEmail (via requestOTP)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch") as unknown as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dev mode: logs OTP, no fetch, returns 200", async () => {
    const env = makeEnv({ ENVIRONMENT: "development" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const resp = await requestOTP(postOTP("alice@example.com"), env);
    expect(resp.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[DEV] OTP for alice@example.com:"));
  });

  it("prod without EMAIL_API_KEY: returns 503 and never calls fetch", async () => {
    const env = makeEnv({ ENVIRONMENT: "production" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const resp = await requestOTP(postOTP("bob@example.com"), env);
    expect(resp.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("prod with EMAIL_API_KEY: calls Resend with bearer + JSON body", async () => {
    const env = makeEnv({
      ENVIRONMENT: "production",
      EMAIL_API_KEY: "re_test_key",
      EMAIL_FROM: "OurCord <noreply@ourcord.test>",
    });
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }) as never);
    const resp = await requestOTP(postOTP("carol@example.com"), env);
    expect(resp.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test_key");
    expect(headers["Content-Type"]).toBe("application/json");
    const payload = JSON.parse(init.body as string);
    expect(payload.from).toBe("OurCord <noreply@ourcord.test>");
    expect(payload.to).toEqual(["carol@example.com"]);
    expect(payload.subject).toMatch(/login code/i);
    // OTP must appear in body so user can read it.
    expect(payload.text).toMatch(/\d{6}/);
  });

  it("prod resend HTTP error → 503, no OTP leaked in error response", async () => {
    const env = makeEnv({
      ENVIRONMENT: "production",
      EMAIL_API_KEY: "re_test_key",
    });
    fetchSpy.mockResolvedValue(
      new Response("forbidden", { status: 403 }) as never,
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const resp = await requestOTP(postOTP("dan@example.com"), env);
    expect(resp.status).toBe(503);
    const body = await resp.json<{ error: string }>();
    expect(body.error).not.toMatch(/\d{6}/);
    // Log should mention status but not contain the actual OTP.
    const logs = errSpy.mock.calls.flat().join(" ");
    expect(logs).toMatch(/403/);
    expect(logs).not.toMatch(/\b\d{6}\b/);
  });

  it("per-recipient daily quota: 11th request in same day is rejected", async () => {
    const env = makeEnv({
      ENVIRONMENT: "production",
      EMAIL_API_KEY: "re_test_key",
      EMAIL_RATE_LIMIT_PER_DAY: "2",
    });
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    // First two should succeed but each goes through cooldown — bypass cooldown
    // by deleting the cooldown KV between calls.
    const kv = env.KV as unknown as { delete: (k: string) => Promise<void> };

    const r1 = await requestOTP(postOTP("eve@example.com"), env);
    expect(r1.status).toBe(200);
    await kv.delete("otp_cooldown:eve@example.com");

    const r2 = await requestOTP(postOTP("eve@example.com"), env);
    expect(r2.status).toBe(200);
    await kv.delete("otp_cooldown:eve@example.com");

    const r3 = await requestOTP(postOTP("eve@example.com"), env);
    expect(r3.status).toBe(503); // quota exhausted → sendOTPEmail throws → 503
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
