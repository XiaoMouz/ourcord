// shortKey abbreviates a base64 public key for compact display (Discord shows
// short device fingerprints similarly). Non-key strings pass through.
export function shortKey(key: string | undefined): string {
  if (!key) return "—";
  if (key.length <= 16) return key;
  return `${key.slice(0, 8)}…${key.slice(-6)}`;
}

// relativeTime renders a unix-second timestamp as a coarse "x 分钟前" label.
// A null/undefined/0 timestamp (never used) renders as a dash.
export function relativeTime(unixSeconds: number | null | undefined, nowMs = Date.now()): string {
  if (!unixSeconds) return "—";
  const deltaSec = Math.floor(nowMs / 1000) - unixSeconds;
  if (deltaSec < 0) return "刚刚";
  if (deltaSec < 60) return `${deltaSec} 秒前`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)} 分钟前`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)} 小时前`;
  return `${Math.floor(deltaSec / 86400)} 天前`;
}

const PATH_TONE: Record<string, string> = {
  direct: "good",
  "next-hop": "fair",
  derp: "fair",
  waiting: "wait",
  degraded: "poor",
  unresolved: "poor",
};

// pathTone classifies a per-peer path label into a CSS tone for badges.
export function pathTone(path: string | undefined): string {
  return (path && PATH_TONE[path]) || "wait";
}
