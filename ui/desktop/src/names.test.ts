import { describe, it, expect } from "vitest";
import { createNameCache, displayName } from "./names";
import type { Profile } from "./bridge";

describe("createNameCache", () => {
  it("batches unknown ids and caches results", async () => {
    const calls: string[][] = [];
    const cache = createNameCache(async (ids) => {
      calls.push(ids);
      return ids.map((id): Profile => ({ id, display_name: id.toUpperCase() }));
    });
    expect(await cache.ensure(["u1", "u2", "u1"])).toBe(true);
    expect(calls).toEqual([["u1", "u2"]]);
    expect(cache.get("u1")).toBe("U1");
    // Known ids are not re-requested.
    expect(await cache.ensure(["u1", "u2"])).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("stops re-requesting ids the server does not know", async () => {
    let calls = 0;
    const cache = createNameCache(async () => { calls += 1; return []; });
    await cache.ensure(["ghost"]);
    await cache.ensure(["ghost"]);
    expect(calls).toBe(1);
    expect(cache.get("ghost")).toBe("");
  });

  it("keeps ids retryable after a lookup failure", async () => {
    let attempts = 0;
    const cache = createNameCache(async (ids) => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return ids.map((id): Profile => ({ id, display_name: "ok" }));
    });
    expect(await cache.ensure(["u1"])).toBe(false);
    expect(await cache.ensure(["u1"])).toBe(true);
    expect(cache.get("u1")).toBe("ok");
  });

  it("ignores empty ids", async () => {
    let called = false;
    const cache = createNameCache(async () => { called = true; return []; });
    expect(await cache.ensure(["", ""])).toBe(false);
    expect(called).toBe(false);
  });
});

describe("displayName", () => {
  it("falls back to an id stub", async () => {
    const cache = createNameCache(async () => []);
    expect(displayName(cache, "abcdef123456")).toBe("abcdef");
    expect(displayName(cache, "")).toBe("未知用户");
  });
});
