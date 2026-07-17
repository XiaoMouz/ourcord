import { describe, it, expect } from "vitest";
import { voiceQuality, qualityBars, pathLabel, connectionLabel, meanPeerLatency } from "./quality";
import type { Peer, Snapshot } from "./bridge";

describe("voiceQuality", () => {
  it("grades a clean link good", () => {
    expect(voiceQuality(40, 0, 10)).toBe("good");
  });
  it("takes the worst dimension", () => {
    expect(voiceQuality(30, 12, 5)).toBe("poor"); // loss dominates
    expect(voiceQuality(200, 0, 5)).toBe("poor"); // latency dominates
    expect(voiceQuality(40, 0, 45)).toBe("fair"); // jitter is fair
  });
  it("ignores absent latency but still grades loss/jitter", () => {
    expect(voiceQuality(0, 1, 10)).toBe("good");
  });
  it("returns unknown with no telemetry", () => {
    expect(voiceQuality(NaN, NaN, NaN)).toBe("unknown");
  });
});

describe("qualityBars", () => {
  it("maps grades to bar counts", () => {
    expect(qualityBars("good")).toBe(3);
    expect(qualityBars("fair")).toBe(2);
    expect(qualityBars("poor")).toBe(1);
    expect(qualityBars("unknown")).toBe(0);
  });
});

describe("pathLabel", () => {
  it("localizes known path summaries", () => {
    expect(pathLabel("direct")).toBe("直连");
    expect(pathLabel("derp")).toBe("中继");
  });
  it("passes through unknown labels and defaults undefined", () => {
    expect(pathLabel("weird")).toBe("weird");
    expect(pathLabel(undefined)).toBe("未连接");
  });
});

describe("connectionLabel", () => {
  const base: Snapshot = { daemon_available: true };
  it("says not connected when voice is idle", () => {
    expect(connectionLabel(base)).toBe("未连接语音");
  });
  it("distinguishes relay from direct", () => {
    expect(connectionLabel({ ...base, voice: { joined: true, muted: false, deafened: false, local_speaking: false, transmitting: false }, status: { vpn_active: true, relay_used: true, path_summary: "derp", path_flaps_total: 0 } })).toBe("语音已连接 · 中继");
    expect(connectionLabel({ ...base, voice: { joined: true, muted: false, deafened: false, local_speaking: false, transmitting: false }, status: { vpn_active: true, relay_used: false, path_summary: "direct", path_flaps_total: 0 } })).toBe("语音已连接 · 直连");
  });
});

describe("meanPeerLatency", () => {
  const peer = (latency_ms: number): Peer => ({ public_key: "k" + latency_ms, name: "n", path: "direct", latency_ms });
  it("averages positive samples and rounds", () => {
    expect(meanPeerLatency([peer(30), peer(50)])).toBe(40);
  });
  it("skips zero/negative samples", () => {
    expect(meanPeerLatency([peer(0), peer(60)])).toBe(60);
  });
  it("returns 0 for no data", () => {
    expect(meanPeerLatency([])).toBe(0);
    expect(meanPeerLatency(undefined)).toBe(0);
  });
});
