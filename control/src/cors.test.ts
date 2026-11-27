import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "./index";
import { makeToken, signToken } from "./auth";
import type { Env } from "./types";

describe("browser control API responses", () => {
  let db: DatabaseSync;
  let env: Env;
  let kv: Map<string, string>;
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    db = new DatabaseSync(":memory:");
    const migrations = join(__dirname, "../migrations");
    for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
      db.exec(readFileSync(join(migrations, file), "utf8"));
    }
    db.exec("INSERT INTO users(id,email,created_at) VALUES ('operator','operator@example.test',1), ('member','member@example.test',1)");
    kv = new Map();
    env = {
      ENVIRONMENT: "development", JWT_SECRET: "cors-local-test-secret", ADMIN_USER_IDS: "operator",
      DB: { prepare(sql: string) {
        let params: unknown[] = [];
        const s = {
          bind(...values: unknown[]) { params = values; return s; },
          async first() { return db.prepare(sql).get(...params) ?? null; },
          async all() { return { results: db.prepare(sql).all(...params) }; },
          async run() { return { meta: db.prepare(sql).run(...params) }; },
        };
        return s;
      } },
      KV: { async get(key: string) { return kv.get(key) ?? null; }, async put(key: string, value: string) { kv.set(key, value); }, async delete(key: string) { kv.delete(key); } },
    } as unknown as Env;
  });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });

  async function call(path: string, init: RequestInit = {}, sub?: string) {
    const headers = new Headers(init.headers);
    headers.set("Origin", "https://console.example.test");
    if (init.body) headers.set("Content-Type", "application/json");
    if (sub) headers.set("Authorization", `Bearer ${await signToken(makeToken(sub, `${sub}@example.test`), env.JWT_SECRET!)}`);
    return worker.fetch(new Request(`https://control.example.test${path}`, { ...init, headers }), env, {} as ExecutionContext);
  }
  function readable(response: Response, status: number) {
    expect(response.status).toBe(status);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  }

  it("allows preflight and both actual OTP responses", async () => {
    const preflight = await call("/api/auth/otp/request", { method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
    readable(preflight, 200);
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
    const requested = await call("/api/auth/otp/request", { method: "POST", body: JSON.stringify({ email: "operator@example.test" }) });
    readable(requested, 200);
    const verified = await call("/api/auth/otp/verify", { method: "POST", body: JSON.stringify({ email: "operator@example.test", otp: kv.get("otp:operator@example.test") }) });
    readable(verified, 200);
    expect(await verified.json()).toMatchObject({ user_id: "operator", token: expect.any(String) });
    expect(kv.has("otp:operator@example.test")).toBe(false);
  });

  it.each([[undefined, 401], ["member", 403], ["operator", 200]] as const)("exposes fleet status to %s without bypassing auth", async (sub, status) => {
    readable(await call("/api/control/fleet", {}, sub), status);
  });

  it("exposes ban-driven session expiry as 401", async () => {
    db.exec("INSERT INTO bans(id,target_type,target_id,created_at) VALUES ('ban','user','operator',1)");
    readable(await call("/api/control/fleet", {}, "operator"), 401);
  });

  it.each([["invalid", 400], ["1025", 413]] as const)("exposes body-size rejection for content-length %s", async (length, status) => {
    readable(await call("/api/auth/otp/request", { method: "POST", headers: { "Content-Length": length }, body: "{}" }), status);
  });

  it("exposes invalid OTP and request validation failures", async () => {
    readable(await call("/api/auth/otp/verify", { method: "POST", body: JSON.stringify({ email: "operator@example.test", otp: "wrong" }) }), 401);
    readable(await call("/api/auth/otp/request", { method: "POST", body: "{}" }), 400);
  });

  it.each([false, true])("exposes unavailable/exhausted rate gates (binding=%s)", async (bound) => {
    env.ENVIRONMENT = "production";
    if (bound) env.RATE_LIMIT_5 = { limit: vi.fn(async () => ({ success: false })) };
    const response = await call("/api/auth/otp/request", { method: "POST", body: "{}" });
    readable(response, bound ? 429 : 503);
    if (bound) expect(response.headers.get("Retry-After")).toBe("60");
  });

  it("preserves scope warnings on peer config", async () => {
    const response = await call("/api/peers/config?room_id=room", {}, "operator");
    readable(response, 200);
    expect(response.headers.get("X-Scope-Warning")).toBeTruthy();
    expect(await response.json()).toEqual({ peers: [], relays: [] });
  });

  it("preserves OAuth cookie clearing on JSON errors", async () => {
    const response = await call("/api/auth/oauth/google/callback");
    readable(response, 400);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});
