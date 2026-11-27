import { afterEach, describe, expect, it, vi } from "vitest";
import { requestDesktopMagic } from "./authHandler";
import type { Env } from "./types";

function kvStub() {
  const values = new Map<string, string>();
  return {
    values,
    api: {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
      delete: vi.fn(async (key: string) => { values.delete(key); }),
    } as unknown as KVNamespace,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("desktop magic login", () => {
  it("stores only a hash of the link token and applies recipient cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));
    const kv = kvStub();
    const env = { KV: kv.api, DB: {} as D1Database, SIGNAL: {} as DurableObjectNamespace, ENVIRONMENT: "development" } as Env;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const request = () => new Request("https://control.example/api/auth/desktop/magic", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "128" },
      body: JSON.stringify({ email: "alice@example.com", code_challenge: "A".repeat(43) }),
    });

    const first = await requestDesktopMagic(request(), env);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ expires_in: 600, retry_after: 60 });
    const magicKeys = [...kv.values.keys()].filter((key) => key.startsWith("desktop_magic:"));
    expect(magicKeys).toHaveLength(1);
    expect(magicKeys[0]).toMatch(/^desktop_magic:[A-Za-z0-9_-]{43}$/);
    expect([...kv.values.values()].join(" ")).not.toContain("alice@example.com?token=");

    const second = await requestDesktopMagic(request(), env);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ expires_in: 600, retry_after: 60 });
    expect([...kv.values.keys()].filter((key) => key.startsWith("desktop_magic:"))).toHaveLength(1);
  });

  it("returns the remaining recipient cooldown to the desktop client", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00Z"));
    const kv = kvStub();
    const env = { KV: kv.api, DB: {} as D1Database, SIGNAL: {} as DurableObjectNamespace, ENVIRONMENT: "development" } as Env;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const request = () => new Request("https://control.example/api/auth/desktop/magic", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "128" },
      body: JSON.stringify({ email: "alice@example.com", code_challenge: "A".repeat(43) }),
    });

    await requestDesktopMagic(request(), env);
    vi.advanceTimersByTime(17_000);
    const response = await requestDesktopMagic(request(), env);

    expect(await response.json()).toMatchObject({ retry_after: 43 });
  });

  it("rejects malformed PKCE challenges", async () => {
    const kv = kvStub();
    const env = { KV: kv.api, DB: {} as D1Database, SIGNAL: {} as DurableObjectNamespace, ENVIRONMENT: "development" } as Env;
    const req = new Request("https://control.example/api/auth/desktop/magic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com", code_challenge: "short" }),
    });
    expect((await requestDesktopMagic(req, env)).status).toBe(400);
  });

  it("does not leave a cooldown when delivery fails", async () => {
    const kv = kvStub();
    const env = { KV: kv.api, DB: {} as D1Database, SIGNAL: {} as DurableObjectNamespace, ENVIRONMENT: "production" } as Env;
    vi.spyOn(console, "log").mockImplementation(() => {});
    const req = new Request("https://control.example/api/auth/desktop/magic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com", code_challenge: "A".repeat(43) }),
    });

    expect((await requestDesktopMagic(req, env)).status).toBe(503);
    expect([...kv.values.keys()].some((key) => key.includes("desktop_magic"))).toBe(false);
  });
});
