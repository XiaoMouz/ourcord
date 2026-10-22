import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runBackendHealthChecks } from "./backends";
import { SCHEMA_SQL } from "./schema";
import type { Env } from "./types";

describe.each(["migrations", "development schema"])("backend health selection with %s", (schema) => {
  let db: DatabaseSync;
  let env: Env;
  let plans: string[];
  let probed: string[];
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    if (schema === "migrations") {
      const dir = join(__dirname, "../migrations");
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
        db.exec(readFileSync(join(dir, file), "utf8"));
      }
    } else db.exec(SCHEMA_SQL);
    plans = [];
    probed = [];
    env = { DB: {
      prepare(sql: string) {
        let params: unknown[] = [];
        const statement = {
          bind(...values: unknown[]) { params = values; return statement; },
          async all() {
            plans.push(...(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((row) => row.detail));
            return { results: db.prepare(sql).all(...params) };
          },
          async run() { return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } }; },
        };
        return statement;
      },
    } as unknown as D1Database } as Env;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const id = new URL(String(input)).hostname.split(".")[0];
      probed.push(id);
      return new Response(null, { status: id === "bad" ? 503 : 200 });
    });
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  function add(id: string, status: string, last: number | null, active = 1) {
    db.prepare(`INSERT INTO file_backends(id,owner_id,base_url,created_at,health_status,last_health_at,active)
      VALUES (?,'owner',?,1,?,?,?)`).run(id, `https://${id}.example`, status, last, active);
  }

  it("takes the global oldest batch across all statuses without sorting the active registry", async () => {
    for (let i = 1; i <= 180; i++) add(`b${i}`, ["healthy", "unknown", "unhealthy"][i % 3], i);
    add("never", "unknown", null);
    add("zero", "healthy", 0);
    add("inactive", "unknown", null, 0);
    expect(await runBackendHealthChecks(env)).toEqual({ checked: 50, healthy: 50, unhealthy: 0 });
    expect(new Set(probed.slice(0, 2))).toEqual(new Set(["never", "zero"]));
    expect(probed.slice(2)).toEqual(Array.from({ length: 48 }, (_, i) => `b${i + 1}`));
    expect(plans.some((plan) => /TEMP B-TREE|SCAN file_backends/.test(plan))).toBe(false);
    probed = [];
    await runBackendHealthChecks(env);
    expect(probed).toEqual(Array.from({ length: 50 }, (_, i) => `b${i + 49}`));
    expect(db.prepare("SELECT last_health_at FROM file_backends WHERE id='inactive'").get()).toEqual({ last_health_at: null });
  });

  it("retains unhealthy outcomes and handles an empty active registry", async () => {
    expect(await runBackendHealthChecks(env)).toEqual({ checked: 0, healthy: 0, unhealthy: 0 });
    add("bad", "healthy", 1);
    add("good", "unhealthy", 2);
    expect(await runBackendHealthChecks(env, 1)).toEqual({ checked: 1, healthy: 0, unhealthy: 1 });
    expect(db.prepare("SELECT health_status,last_health_error FROM file_backends WHERE id='bad'").get())
      .toEqual({ health_status: "unhealthy", last_health_error: "health returned 503" });
    expect(await runBackendHealthChecks(env, 1)).toEqual({ checked: 1, healthy: 1, unhealthy: 0 });
    expect(probed).toEqual(["bad", "good"]);
  });

  it.each(["unknown", "healthy", "unhealthy"])("includes never-checked %s backends before dated checks", async (status) => {
    add("dated", status, 1);
    add("never", status, null);
    expect(await runBackendHealthChecks(env, 1)).toEqual({ checked: 1, healthy: 1, unhealthy: 0 });
    expect(probed).toEqual(["never"]);
    probed = [];
    await runBackendHealthChecks(env, 1);
    expect(probed).toEqual(["dated"]);
  });
});
