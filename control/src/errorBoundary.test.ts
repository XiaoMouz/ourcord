import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { makeToken, signToken } from "./auth";
import type { Env } from "./types";

const SECRET = "test-error-boundary-secret";
const failure = new Error("injected storage failure");

describe("control route error boundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const routes = [
    ["GET", "/api/me", undefined],
    ["PATCH", "/api/me", { display_name: "new name" }],
    ["DELETE", "/api/devices/device-id", undefined],
    ["POST", "/api/auth/desktop/exchange", { code: "a".repeat(64), code_verifier: "v".repeat(43) }],
    ["POST", "/api/auth/otp/request", { email: "test@example.test" }],
  ] as const;

  it.each(routes)("contains async failures from %s %s", async (method, path, body) => {
    const reject = vi.fn(async () => { throw failure; });
    const env = {
      ENVIRONMENT: "production", JWT_SECRET: SECRET,
      DB: { prepare: () => ({ bind: () => ({ first: reject }) }) },
      KV: { get: reject },
      RATE_LIMIT_5: { limit: async () => ({ success: true }) },
      RATE_LIMIT_20: { limit: async () => ({ success: true }) },
    } as unknown as Env;
    const token = await signToken(makeToken("u1", "test@example.test"), SECRET);
    const response = await worker.fetch(new Request(`https://test${path}`, {
      method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body),
    }), env, {} as ExecutionContext);
    expect(reject).toHaveBeenCalled();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
    const start = JSON.parse(vi.mocked(console.log).mock.calls[0][0]);
    const errors = vi.mocked(console.error).mock.calls.map(([line]) => JSON.parse(line));
    expect(errors).toEqual([expect.objectContaining({
      event: "request.error", request_id: start.request_id, method, path, error: String(failure),
    })]);
  });

  it.each(["production", "development"])("retains %s error detail policy", async (environment) => {
    const response = await worker.fetch(new Request("https://test/api/auth/otp/request", {
      method: "POST", body: "{", headers: { "Content-Type": "application/json" },
    }), { ENVIRONMENT: environment, RATE_LIMIT_5: { limit: async () => ({ success: true }) } } as unknown as Env, {} as ExecutionContext);
    expect(response.status).toBe(500);
    const body = await response.json<{ error: string; detail?: string }>();
    expect(body.error).toBe("Internal server error");
    if (environment === "development") expect(body.detail).toEqual(expect.any(String));
    else expect(body).not.toHaveProperty("detail");
  });
});
