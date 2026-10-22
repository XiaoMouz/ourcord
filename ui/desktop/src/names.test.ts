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

  it.each([90, 91, 180, 181])("bounds batches for %i names and retains all results", async (count) => {
    const ids = Array.from({ length: count }, (_, i) => `user-${i}`);
    const calls: string[][] = [];
    const cache = createNameCache(async (batch) => {
      calls.push(batch);
      if (batch.length > 90) throw new Error("HTTP 400: at most 90 ids");
      return batch.map((id) => ({ id, display_name: id }));
    });
    expect(await cache.ensure([...ids, ...ids])).toBe(true);
    expect(calls.flat()).toEqual(ids);
    expect(calls.every((batch) => batch.length <= 90)).toBe(true);
    expect(ids.map((id) => cache.get(id))).toEqual(ids);
    expect(await cache.ensure(ids)).toBe(false);
  });

  it("preserves completed batches and stops issuing requests after an error", async () => {
    const ids = Array.from({ length: 181 }, (_, i) => `user-${i}`);
    const calls: string[][] = [];
    let failing = true;
    const cache = createNameCache(async (batch) => {
      calls.push(batch);
      if (batch.length > 90 || failing && batch.includes(ids[90])) throw new Error("unavailable");
      return batch.map((id) => ({ id, display_name: id }));
    });
    expect(await cache.ensure(ids)).toBe(true);
    expect(calls.map((batch) => batch.length)).toEqual([90, 90]);
    expect(cache.get(ids[89])).toBe(ids[89]);
    expect(cache.get(ids[90])).toBeUndefined();
    failing = false;
    expect(await cache.ensure(ids)).toBe(true);
    expect(calls.slice(2).flat()).toEqual(ids.slice(90));
  });

  it("reserves queued ids so overlapping consumers do not send them again", async () => {
    const ids = Array.from({ length: 181 }, (_, i) => `user-${i}`);
    const calls: string[][] = [];
    let release!: () => void;
    const blocked = new Promise<void>((done) => { release = done; });
    const cache = createNameCache(async (batch) => {
      calls.push(batch);
      if (calls.length === 1) await blocked;
      return batch.map((id) => ({ id, display_name: id }));
    });
    const pending = cache.ensure(ids);
    expect(await cache.ensure(ids.slice(90))).toBe(false);
    expect(calls).toHaveLength(1);
    release();
    expect(await pending).toBe(true);
    expect(calls.map((batch) => batch.length)).toEqual([90, 90, 1]);
    expect(calls.flat()).toEqual(ids);
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
