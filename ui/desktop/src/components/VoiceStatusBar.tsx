import { bridge, type Snapshot } from "../bridge";
import { connectionLabel, meanPeerLatency, pathLabel, voiceQuality } from "../quality";
import SignalBars from "./SignalBars";
import { IconButton, cx } from "./ui";

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

  return <div className={cx("card card-border mx-3 mb-3 bg-base-200", connecting && "border-primary/40")}>
    <div className="card-body gap-3 p-3">
    <div className="flex items-center gap-3">
      <SignalBars quality={quality} />
      <div className="min-w-0 flex-1">
        <strong className="block truncate text-sm text-success">{label}</strong>
        <small className="block truncate text-xs text-base-content/50">{connecting ? "协商路径中" : `${pathLabel(snapshot.status?.path_summary)}${latency > 0 ? ` · ${latency}ms` : ""}`}</small>
      </div>
      <IconButton label="断开语音" className="btn-error btn-soft" disabled={busy} onClick={onLeave}>⏻</IconButton>
    </div>
    {joined && <div className="flex items-center gap-2">
      <button className={cx("btn btn-sm flex-1", snapshot.voice?.muted && "btn-error btn-soft")} onClick={() => void toggleMute()}>
        {snapshot.voice?.muted ? "已静音" : "静音"}
      </button>
      <span className={cx("badge badge-sm", snapshot.voice?.transmitting ? "badge-success" : "badge-ghost")}>
        {snapshot.voice?.transmitting ? "发送中" : "空闲"}
      </span>
    </div>}
    </div>
  </div>;
}
