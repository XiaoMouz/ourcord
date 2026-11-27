import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "./index";
import { confirmDesktopMagic, exchangeDesktopCode, requestDesktopMagic } from "./authHandler";
import type { Env } from "./types";

describe("desktop authorization code lifecycle (real SQLite)", () => {
  let db: DatabaseSync;
  let env: Env;
  const verifier = "v".repeat(43);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const directory = join(__dirname, "../migrations");
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
      db.exec(readFileSync(join(directory, name), "utf8"));
    }
    const prepare = (sql: string) => {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { params = values; return statement; },
        async first() { return db.prepare(sql).get(...params) ?? null; },
        async run() { return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } }; },
      };
      return statement;
    };
    const values = new Map<string, string>();
    env = {
      ENVIRONMENT: "development", JWT_SECRET: "desktop-code-cleanup-test-secret",
      DB: { prepare } as unknown as D1Database,
      KV: {
        async get(key: string) { return values.get(key) ?? null; },
        async put(key: string, value: string) { values.set(key, value); },
        async delete(key: string) { values.delete(key); },
      } as unknown as KVNamespace,
    } as Env;
  });
  afterEach(() => {
    db.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function post(path: string, body: unknown) {
    return new Request(`https://control.test${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  }
  async function issueThroughMagicConfirmation() {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect((await requestDesktopMagic(post("/api/auth/desktop/magic", {
      email: "alice@example.test", code_challenge: challenge,
    }), env)).status).toBe(200);
    const entry = vi.mocked(console.log).mock.calls.map(([line]) => JSON.parse(String(line)))
      .find((entry) => entry.event === "desktop_magic.dev_print");
    const link = new URL(entry.confirm_url);
    const confirmed = await confirmDesktopMagic(new Request(link, {
      method: "POST", body: new URLSearchParams({ token: link.searchParams.get("token")! }),
    }), env);
    expect(confirmed.status).toBe(200);
    expect(confirmed.headers.get("Location")).toBeNull();
    expect(confirmed.headers.get("Cache-Control")).toBe("no-store");
    expect(confirmed.headers.get("Referrer-Policy")).toBe("no-referrer");
    const html = await confirmed.text();
    expect(html).toContain("Open OurCord");
    expect(html).not.toContain(link.searchParams.get("token")!);
    expect(html).not.toContain("<form");
    const callback = html.match(/href="(ourcord:\/\/auth\?code=[a-f0-9]{64})"/);
    expect(callback, "confirmation must retain a clickable callback when app launch fails").not.toBeNull();
    return new URL(callback![1]).searchParams.get("code")!;
  }
  function count() {
    return (db.prepare("SELECT COUNT(*) AS n FROM desktop_auth_codes").get() as { n: number }).n;
  }
  async function scheduled() {
    const handler = (worker as ExportedHandler<Env>).scheduled;
    expect(handler, "control must register an expiry cleanup handler").toBeTypeOf("function");
    await handler!.call(worker, {
      scheduledTime: Date.now(), cron: "0 * * * *", noRetry() {},
    } as ScheduledController, env, {} as ExecutionContext);
  }

  it("retires a confirmed login abandoned before desktop exchange", async () => {
    const code = await issueThroughMagicConfirmation();
    expect(count()).toBe(1);
    // The browser confirmation succeeded, but the user did not open the app.
    vi.advanceTimersByTime(61_000);
    const expired = await exchangeDesktopCode(post("/api/auth/desktop/exchange", {
      code, code_verifier: verifier,
    }), env);
    expect(expired.status).toBe(401);
    expect(count()).toBe(1); // Expiry rejects authentication, not storage.
    await scheduled();
    expect(count()).toBe(0);
    await scheduled();
    expect(count()).toBe(0);
  });

  it("preserves a still-valid code and its one-time PKCE exchange", async () => {
    const code = await issueThroughMagicConfirmation();
    await scheduled();
    expect(count()).toBe(1);
    const exchange = () => exchangeDesktopCode(post("/api/auth/desktop/exchange", {
      code, code_verifier: verifier,
    }), env);
    expect((await exchange()).status).toBe(200);
    expect(count()).toBe(0);
    expect((await exchange()).status).toBe(401);
  });

  it("retains a handoff code after an incorrect PKCE verifier without accepting it", async () => {
    const code = await issueThroughMagicConfirmation();
    expect((await exchangeDesktopCode(post("/api/auth/desktop/exchange", {
      code, code_verifier: "w".repeat(43),
    }), env)).status).toBe(401);
    expect(count()).toBe(1);
    expect((await exchangeDesktopCode(post("/api/auth/desktop/exchange", {
      code, code_verifier: verifier,
    }), env)).status).toBe(200);
    expect(count()).toBe(0);
  });

  it("matches the exchange expiry boundary instead of deleting a code one second early", async () => {
    const code = await issueThroughMagicConfirmation();
    vi.advanceTimersByTime(60_000);
    await scheduled();
    expect(count()).toBe(1);
    expect((await exchangeDesktopCode(post("/api/auth/desktop/exchange", {
      code, code_verifier: verifier,
    }), env)).status).toBe(200);
  });

  it("drains historical expired codes in bounded oldest-first batches", async () => {
    await issueThroughMagicConfirmation();
    const user = db.prepare("SELECT id FROM users").get() as { id: string };
    const now = Math.floor(Date.now() / 1000);
    const insert = db.prepare("INSERT INTO desktop_auth_codes VALUES (?, ?, 'alice@example.test', ?, ?)");
    for (let i = 0; i < 600; i++) insert.run(`expired-${i}`, user.id, "A".repeat(43), now - 600 + i);
    await scheduled();
    expect(count()).toBe(101);
    expect(db.prepare("SELECT MIN(expires_at) AS oldest FROM desktop_auth_codes").get()).toEqual({ oldest: now - 100 });
    await scheduled();
    expect(count()).toBe(1);
  });

  it("surfaces a failed cleanup and retries remaining rows at the next invocation", async () => {
    await issueThroughMagicConfirmation();
    vi.advanceTimersByTime(61_000);
    db.exec(`CREATE TRIGGER fail_cleanup BEFORE DELETE ON desktop_auth_codes
      BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END`);
    await expect(scheduled()).rejects.toThrow("injected cleanup failure");
    expect(count()).toBe(1);
    db.exec("DROP TRIGGER fail_cleanup");
    await scheduled();
    expect(count()).toBe(0);
  });
});
