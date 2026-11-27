import { bridge, type Snapshot } from "../bridge";
import { connectionLabel, meanPeerLatency, voiceQuality } from "../quality";
import SignalBars from "./SignalBars";

export default function CallBar({ snapshot, busy, shortcut, connecting, roomName, onLeave, refresh, onError }: {
  snapshot: Snapshot;
  busy: boolean;
  shortcut: string;
  connecting: boolean;
  roomName?: string;
  onLeave: () => void;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  async function toggle(method: "voice.mute" | "voice.deafen", params: Record<string, unknown>) {
    try { await bridge(method, params); await refresh(); }
    catch (e) { onError(String(e)); }
  }
  const voice = snapshot.voice;
  const latency = meanPeerLatency(snapshot.peers);
  const participants = voice?.participants ?? [];
  const quality = voiceQuality(
    latency || NaN,
    Math.max(...participants.map((p) => p.loss_percent)),
    Math.max(...participants.map((p) => p.jitter_ms)),
  );
  const mutedLabel = voice?.muted ? "取消静音" : "静音";
  const disabled = !voice?.joined || connecting || busy;
  return <footer className="call-dock" aria-label="语音通话">
    <span className="dock-signal">{connecting ? <span className="loading loading-spinner loading-sm" /> : <SignalBars quality={quality} />}</span>
    <div className="call-location">
      <strong title={roomName}>{roomName || "语音通话"}</strong>
      <small>{connecting ? "正在连接语音…" : connectionLabel(snapshot)}{latency > 0 && !connecting && ` · ${latency} ms`}</small>
    </div>
    {!connecting && <span className="dock-mode">{voice?.transmitting ? "正在发送" : voice?.input_mode === "push_to_talk" ? `按键说话 · ${shortcut}` : ""}</span>}
    <div className="dock-controls">
      <button className="btn" disabled={disabled} data-tip={mutedLabel} aria-pressed={!!voice?.muted}
        onClick={() => void toggle("voice.mute", { muted: !voice?.muted })}>{mutedLabel}</button>
      <button className="btn" disabled={disabled} aria-pressed={!!voice?.deafened}
        onClick={() => void toggle("voice.deafen", { deafened: !voice?.deafened })}>{voice?.deafened ? "恢复耳机" : "耳机静音"}</button>
      <button className="btn dock-leave" data-tip="断开语音" disabled={disabled} onClick={onLeave}>断开语音</button>
    </div>
  </footer>;
}
