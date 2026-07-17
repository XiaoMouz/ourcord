import type { Peer, Snapshot } from "./bridge";

export type Quality = "good" | "fair" | "poor" | "unknown";

// voiceQuality grades a link the way Discord's signal bars do: take the worst
// of latency / loss / jitter so one bad dimension is not hidden by two good
// ones. Missing telemetry (a peer that hasn't reported yet) is "unknown".
export function voiceQuality(latencyMs: number, lossPercent: number, jitterMs: number): Quality {
  if (!Number.isFinite(latencyMs) && !Number.isFinite(lossPercent) && !Number.isFinite(jitterMs)) return "unknown";
  const grades: Quality[] = [];
  if (Number.isFinite(latencyMs) && latencyMs > 0) grades.push(latencyMs < 60 ? "good" : latencyMs < 150 ? "fair" : "poor");
  if (Number.isFinite(lossPercent)) grades.push(lossPercent < 2 ? "good" : lossPercent < 8 ? "fair" : "poor");
  if (Number.isFinite(jitterMs)) grades.push(jitterMs < 30 ? "good" : jitterMs < 60 ? "fair" : "poor");
  if (grades.length === 0) return "unknown";
  if (grades.includes("poor")) return "poor";
  if (grades.includes("fair")) return "fair";
  return "good";
}

// Number of filled signal bars (0..3) for a quality grade.
export function qualityBars(quality: Quality): number {
  return quality === "good" ? 3 : quality === "fair" ? 2 : quality === "poor" ? 1 : 0;
}

const PATH_LABELS: Record<string, string> = {
  direct: "直连",
  derp: "中继",
  "next-hop": "中转",
  waiting: "连接中",
  degraded: "不稳定",
  "no-peers": "等待成员",
  inactive: "未连接",
};

export function pathLabel(pathSummary?: string): string {
  return (pathSummary && PATH_LABELS[pathSummary]) || pathSummary || "未连接";
}

// connectionLabel is the one-line voice status shown in the persistent bar,
// mirroring Discord's "Voice Connected" / relay wording.
export function connectionLabel(snapshot: Snapshot): string {
  if (!snapshot.voice?.joined) return "未连接语音";
  if (snapshot.status?.relay_used) return "语音已连接 · 中继";
  if (snapshot.status?.path_summary === "direct") return "语音已连接 · 直连";
  return "语音已连接";
}

// meanPeerLatency averages the reported round-trips of peers that have a
// positive latency sample, for the single ping figure Discord surfaces.
export function meanPeerLatency(peers: Peer[] | undefined): number {
  const samples = (peers ?? []).map((peer) => peer.latency_ms).filter((ms) => Number.isFinite(ms) && ms > 0);
  if (samples.length === 0) return 0;
  return Math.round(samples.reduce((sum, ms) => sum + ms, 0) / samples.length);
}
