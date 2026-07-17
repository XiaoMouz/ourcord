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

// parseAttachments reads a message's attachments column (a JSON array of file
// id / ref strings) defensively — malformed or non-array JSON yields [].
export function parseAttachments(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0);
  } catch {
    return [];
  }
}

// formatBytes renders a byte count in the largest sensible unit.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
