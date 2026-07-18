import { describe, it, expect, vi } from "vitest";
import { getBackendHealthSummary } from "./opsBackends";
import type { Env } from "./types";

type DBStep = { first?: unknown; run?: unknown; all?: unknown };

// getBackendHealthSummary issues two queries in order: the GROUP BY rollup
// (.all) then the bounded unhealthy-detail list (.all).
function makeDB(plan: DBStep[]): D1Database {
  let i = 0;
  return {
    prepare: vi.fn(() => {
      const idx = i++;
      const step = () => plan[idx] || {};
      const s: any = {
        bind: vi.fn(() => s),
        first: vi.fn(async () => step().first ?? null),
        run: vi.fn(async () => step().run ?? { meta: { changes: 1 } }),
        all: vi.fn(async () => step().all ?? { results: [] }),
      };
      return s as D1PreparedStatement;
    }),
    batch: vi.fn(),
    exec: vi.fn(),
  } as unknown as D1Database;
}

function envOf(db: D1Database): Env {
  return { DB: db } as Env;
}

describe("getBackendHealthSummary", () => {
  it("rolls up healthy/unhealthy/unknown so total == sum of the three", async () => {
    const db = makeDB([
      { all: { results: [
        { status: "healthy", c: 5 },
        { status: "unhealthy", c: 2 },
        { status: null, c: 3 },
      ] } },
      { all: { results: [
        { id: "b1", name: "one", base_url: "https://one.example", last_health_at: 100, last_health_error: "health returned 500" },
        { id: "b2", name: "two", base_url: "https://two.example", last_health_at: 90, last_health_error: "fetch failed" },
      ] } },
    ]);
    const summary = await getBackendHealthSummary(envOf(db));
    expect(summary.total).toBe(10);
    expect(summary.healthy).toBe(5);
    expect(summary.unhealthy).toBe(2);
    expect(summary.unknown).toBe(3);
    expect(summary.total).toBe(summary.healthy + summary.unhealthy + summary.unknown);
    expect(summary.unhealthy_backends).toHaveLength(2);
    expect(summary.unhealthy_backends[0]).toMatchObject({ id: "b1" });
  });

  it("treats any non-healthy/unhealthy status (incl. NULL and 'unknown') as unknown", async () => {
    const db = makeDB([
      { all: { results: [
        { status: null, c: 1 },
        { status: "unknown", c: 4 },
      ] } },
      { all: { results: [] } },
    ]);
    const summary = await getBackendHealthSummary(envOf(db));
    expect(summary.unknown).toBe(5);
    expect(summary.healthy).toBe(0);
    expect(summary.unhealthy).toBe(0);
    expect(summary.total).toBe(5);
  });

  it("empty registry → all zeros, no detail rows", async () => {
    const db = makeDB([{ all: { results: [] } }, { all: { results: [] } }]);
    const summary = await getBackendHealthSummary(envOf(db));
    expect(summary).toEqual({ total: 0, healthy: 0, unhealthy: 0, unknown: 0, unhealthy_backends: [] });
  });
});
