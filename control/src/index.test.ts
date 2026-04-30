import { describe, it, expect } from "vitest";
import worker from "./index";
import type { Env } from "./types";

function makeEnv(overrides: Partial<Env & { ADMIN_TOKEN?: string }> = {}): Env {
  return {
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    SIGNAL: {} as DurableObjectNamespace,
    ENVIRONMENT: "development",
    ADMIN_TOKEN: "secret-admin-token",
    ...overrides,
  } as Env;
}

function initDbReq(headers: Record<string, string> = {}): Request {
  return new Request("https://control.example/api/admin/init-db", {
    method: "POST",
    headers,
  });
}

const ctx = {} as ExecutionContext;

describe("POST /api/admin/init-db ADMIN_TOKEN guard (Y3)", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const res = await worker.fetch(initDbReq(), makeEnv(), ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 when bearer token is wrong", async () => {
    const res = await worker.fetch(
      initDbReq({ Authorization: "Bearer not-the-right-token" }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 200 with migration message when bearer token matches env", async () => {
    const res = await worker.fetch(
      initDbReq({ Authorization: "Bearer secret-admin-token" }),
      makeEnv(),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; msg: string };
    expect(body.ok).toBe(true);
    expect(body.msg).toMatch(/wrangler d1 migrations apply/);
  });

  it("returns 503 when ADMIN_TOKEN is not configured in env", async () => {
    const env = makeEnv({ ADMIN_TOKEN: undefined });
    const res = await worker.fetch(
      initDbReq({ Authorization: "Bearer anything" }),
      env,
      ctx,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "ADMIN_TOKEN not configured" });
  });
});
