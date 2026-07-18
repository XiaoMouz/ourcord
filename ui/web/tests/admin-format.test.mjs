import assert from "node:assert/strict";
import test from "node:test";

import {
  formatBps,
  formatRelative,
  loadPercent,
  healthBadge,
  summarizeRelays,
} from "../app/admin/format.mjs";

test("formatBps scales through byte units", () => {
  assert.equal(formatBps(0), "0 B/s");
  assert.equal(formatBps(-5), "0 B/s");
  assert.equal(formatBps(512), "512 B/s");
  assert.equal(formatBps(2048), "2 KB/s");
  assert.equal(formatBps(1536), "1.5 KB/s");
  assert.equal(formatBps(5 * 1024 * 1024), "5 MB/s");
});

test("formatRelative buckets by magnitude", () => {
  const now = 1_000_000; // seconds
  const nowMs = now * 1000;
  assert.equal(formatRelative(0, nowMs), "never");
  assert.equal(formatRelative(now, nowMs), "just now");
  assert.equal(formatRelative(now - 30, nowMs), "30s ago");
  assert.equal(formatRelative(now - 120, nowMs), "2m ago");
  assert.equal(formatRelative(now - 7200, nowMs), "2h ago");
  assert.equal(formatRelative(now - 2 * 86400, nowMs), "2d ago");
  // Future/clock-skew timestamps never go negative.
  assert.equal(formatRelative(now + 100, nowMs), "just now");
});

test("loadPercent converts bytes/sec against a kbps capacity", () => {
  assert.equal(loadPercent(0, 10000), 0);
  assert.equal(loadPercent(1000, 0), 0); // undefined capacity → 0, no divide-by-zero
  // 125000 B/s = 1000 kbps = 10% of 10000 kbps.
  assert.equal(loadPercent(125000, 10000), 10);
  assert.equal(loadPercent(1_250_000, 10000), 100);
  // Overload is clamped, not unbounded.
  assert.equal(loadPercent(1_000_000_000, 1), 999);
});

test("healthBadge maps boolean to a css class", () => {
  assert.deepEqual(healthBadge(true), { label: "up", cls: "up" });
  assert.deepEqual(healthBadge(false), { label: "down", cls: "down" });
});

test("summarizeRelays counts up/down", () => {
  assert.deepEqual(summarizeRelays([]), { total: 0, up: 0, down: 0 });
  assert.deepEqual(summarizeRelays(null), { total: 0, up: 0, down: 0 });
  assert.deepEqual(
    summarizeRelays([{ healthy: true }, { healthy: false }, { healthy: true }]),
    { total: 3, up: 2, down: 1 },
  );
});
