import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Snapshot } from "../bridge";
import VoiceStage from "./VoiceStage";

describe("VoiceStage", () => {
  it("never falls back to another member's device name", () => {
    const snapshot = {
      daemon_available: true,
      peers: [{ public_key: "peer-key", user_id: "u2", name: "Private MacBook Name", path: "direct", latency_ms: 20 }],
      voice: {
        joined: true, muted: false, deafened: false, local_speaking: false, transmitting: false,
        participants: [{ public_key: "peer-key", speaking: false, secure: true, loss_percent: 0, jitter_ms: 1 }],
      },
    } as Snapshot;

    const html = renderToStaticMarkup(<VoiceStage snapshot={snapshot} selfName="Me" />);
    expect(html).toContain("未知成员");
    expect(html).not.toContain("Private MacBook Name");
  });
});

