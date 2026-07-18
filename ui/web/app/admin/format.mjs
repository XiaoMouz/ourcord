// Presentational helpers for the operator fleet console. Kept as a standalone
// ESM module (no framework imports) so they can be unit-tested directly with
// `node --test` without a bundler — see tests/admin-format.test.mjs. The data
// correctness itself is covered by control/src/ops.test.ts.

/**
 * Human-readable throughput from a bytes/sec counter.
 * @param {number} bytesPerSec
 * @returns {string}
 */
export function formatBps(bytesPerSec) {
  const b = Number(bytesPerSec) || 0;
  if (b <= 0) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const num = v >= 10 || i === 0 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
  return `${num} ${units[i]}`;
}

/**
 * Relative "…ago" label for a UNIX-seconds timestamp. 0/absent → "never".
 * @param {number} unixSeconds
 * @param {number} [nowMs]
 * @returns {string}
 */
export function formatRelative(unixSeconds, nowMs = Date.now()) {
  const ts = Number(unixSeconds) || 0;
  if (ts <= 0) return "never";
  const deltaSec = Math.max(0, Math.floor(nowMs / 1000) - ts);
  if (deltaSec < 5) return "just now";
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}

/**
 * Percent of a relay's soft capacity currently in use, from its bytes/sec load
 * and capacity_kbps hint. Clamped to [0, 999]; capacity 0 → 0.
 * @param {number} bytesPerSec
 * @param {number} capacityKbps
 * @returns {number}
 */
export function loadPercent(bytesPerSec, capacityKbps) {
  const cap = Number(capacityKbps) || 0;
  if (cap <= 0) return 0;
  const kbps = (Number(bytesPerSec) || 0) * 8 / 1000;
  return Math.min(999, Math.round((kbps / cap) * 100));
}

/**
 * Health badge descriptor for a relay row.
 * @param {boolean} healthy
 * @returns {{ label: string, cls: "up" | "down" }}
 */
export function healthBadge(healthy) {
  return healthy ? { label: "up", cls: "up" } : { label: "down", cls: "down" };
}

/**
 * Roll a relay list into {total, up, down} for the header summary.
 * @param {Array<{ healthy?: boolean }>} relays
 * @returns {{ total: number, up: number, down: number }}
 */
export function summarizeRelays(relays) {
  const list = Array.isArray(relays) ? relays : [];
  const up = list.filter((r) => r && r.healthy).length;
  return { total: list.length, up, down: list.length - up };
}
