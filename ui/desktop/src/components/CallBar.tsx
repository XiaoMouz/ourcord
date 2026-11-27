import { bridge, type Snapshot } from "../bridge";
import { connectionLabel, meanPeerLatency, voiceQuality } from "../quality";
import Icon from "./Icon";
import SignalBars from "./SignalBars";

export default function CallBar({ snapshot, busy, shortcut, connecting, roomName, onReturn, onLeave, refresh, onError }: {
  snapshot: Snapshot;
  busy: boolean;
  shortcut: string;
  connecting: boolean;
  roomName?: string;
  onReturn?: () => void;
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
  const label = connecting ? "正在连接语音…" : connectionLabel(snapshot);
  return <section className="call-dock" aria-label="语音通话">
    <div className="call-status">
      {connecting ? <span className="loading loading-spinner loading-sm" /> : <SignalBars quality={quality} />}
      <strong>{label}</strong>
    </div>
    <div className="call-location">
      {onReturn ? <button type="button" onClick={onReturn} title={`返回 ${roomName}`}>{roomName}</button> : <span>{roomName || "语音通话"}</span>}
      {latency > 0 && !connecting && <small>{latency} ms</small>}
    </div>
    {!connecting && (voice?.transmitting || voice?.input_mode === "push_to_talk") &&
      <small className="dock-mode">{voice.transmitting ? "正在发送" : `按键说话 · ${shortcut}`}</small>}
    <div className="dock-controls">
      <button disabled={disabled} title={mutedLabel} aria-label={mutedLabel} data-tip={mutedLabel} aria-pressed={!!voice?.muted}
        onClick={() => void toggle("voice.mute", { muted: !voice?.muted })}><Icon name={voice?.muted ? "micOff" : "mic"} /></button>
      <button disabled={disabled} title={voice?.deafened ? "恢复耳机" : "耳机静音"} aria-label={voice?.deafened ? "恢复耳机" : "耳机静音"} aria-pressed={!!voice?.deafened}
        onClick={() => void toggle("voice.deafen", { deafened: !voice?.deafened })}><Icon name={voice?.deafened ? "phonesOff" : "phones"} /></button>
      <button className="dock-leave" title="断开语音" aria-label="断开语音" data-tip="断开语音" disabled={disabled} onClick={onLeave}><Icon name="leave" /></button>
    </div>
  </section>;
}
