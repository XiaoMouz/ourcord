import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import { hmacSign } from "./auth";
import type { Env } from "./types";

const SECRET = "test-error-boundary-secret";
const failure = new Error("injected storage failure");

describe("service route error boundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const routes = [
    ["GET", "/api/lobbies/L1", undefined],
    ["POST", "/api/rooms/R1/messages", { content: "message" }],
    ["DELETE", "/api/rooms/R1/messages/M1", undefined],
    ["PATCH", "/api/rooms/R1", { name: "new name" }],
    ["POST", "/api/rooms/R1/files", { filename: "file.txt", size: 1 }],
  ] as const;

  it.each(routes)("contains async failures from %s %s", async (method, path, body) => {
    const reject = vi.fn(async () => { throw failure; });
    const env = {
      ENVIRONMENT: "production", JWT_SECRET: SECRET,
      DB: { prepare: () => ({ bind: () => ({ first: reject }) }) },
      RATE_LIMIT_30: { limit: async () => ({ success: true }) },
      RATE_LIMIT_120: { limit: async () => ({ success: true }) },
    } as unknown as Env;
    const data = btoa(JSON.stringify({ sub: "u1", email: "test@example.test", iat: 1, exp: 9999999999 })).replace(/=+$/, "");
    const response = await worker.fetch(new Request(`https://test${path}`, {
      method, headers: { Authorization: `Bearer ${data}.${await hmacSign(SECRET, data)}` }, body: body && JSON.stringify(body),
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
    const env = { ENVIRONMENT: environment, JWT_SECRET: SECRET,
      DB: { prepare: () => ({ bind: () => ({ all: async () => { throw failure; } }) }) },
    } as unknown as Env;
    const data = btoa(JSON.stringify({ sub: "u1", email: "test@example.test", iat: 1, exp: 9999999999 })).replace(/=+$/, "");
    const response = await worker.fetch(new Request("https://test/api/lobbies", {
      headers: { Authorization: `Bearer ${data}.${await hmacSign(SECRET, data)}` },
    }), env, {} as ExecutionContext);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(environment === "development"
      ? { error: "Internal server error", detail: failure.message }
      : { error: "Internal server error" });
  });
});
