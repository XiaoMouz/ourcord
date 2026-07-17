import { bridge, type Snapshot } from "../bridge";
import { connectionLabel, meanPeerLatency, pathLabel, voiceQuality } from "../quality";
import SignalBars from "./SignalBars";

// Persistent voice panel (Discord's bottom-left status). Shows connection
// state + representative ping + path, with quick mute/disconnect, and stays
// visible while browsing text rooms so leaving voice never requires
// navigating back to the voice channel.
export default function VoiceStatusBar({ snapshot, connecting, busy, onLeave, refresh, onError }: {
  snapshot: Snapshot;
  connecting: boolean;
  busy: boolean;
  onLeave: () => void;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const joined = !!snapshot.voice?.joined;
  if (!joined && !connecting) return null;

  const latency = meanPeerLatency(snapshot.peers);
  const worstLoss = Math.max(0, ...(snapshot.voice?.participants ?? []).map((p) => p.loss_percent));
  const quality = connecting ? "unknown" : voiceQuality(latency || NaN, worstLoss, 0);
  const label = connecting ? "正在连接语音…" : connectionLabel(snapshot);

  async function toggleMute() {
    try { await bridge("voice.mute", { muted: !snapshot.voice?.muted }); await refresh(); }
    catch (e) { onError(String(e)); }
  }

  return <div className={connecting ? "voice-status connecting" : "voice-status"}>
    <div className="voice-status-head">
      <SignalBars quality={quality} />
      <div className="voice-status-text">
        <strong>{label}</strong>
        <small>{connecting ? "协商路径中" : `${pathLabel(snapshot.status?.path_summary)}${latency > 0 ? ` · ${latency}ms` : ""}`}</small>
      </div>
      <button className="voice-status-hangup" title="断开语音" disabled={busy} onClick={onLeave}>⏻</button>
    </div>
    {joined && <div className="voice-status-actions">
      <button className={snapshot.voice?.muted ? "active" : ""} onClick={() => void toggleMute()}>
        {snapshot.voice?.muted ? "已静音" : "静音"}
      </button>
      <span className={snapshot.voice?.transmitting ? "tx on" : "tx"}>{snapshot.voice?.transmitting ? "发送中" : "空闲"}</span>
    </div>}
  </div>;
}
