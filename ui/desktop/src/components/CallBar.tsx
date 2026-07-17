import { bridge, type Snapshot } from "../bridge";

export default function CallBar({ snapshot, busy, shortcut, onLeave, refresh, onError }: {
  snapshot: Snapshot;
  busy: boolean;
  shortcut: string;
  onLeave: () => void;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  async function toggle(method: "voice.mute" | "voice.deafen", params: Record<string, unknown>) {
    try { await bridge(method, params); await refresh(); }
    catch (e) { onError(String(e)); }
  }
  return <div className="call-bar">
    <button className={snapshot.voice?.muted ? "control danger" : "control"}
      onClick={() => void toggle("voice.mute", { muted: !snapshot.voice?.muted })}>
      ⌁<span>{snapshot.voice?.muted ? "取消静音" : "静音"}</span>
    </button>
    <button className={snapshot.voice?.deafened ? "control danger" : "control"}
      onClick={() => void toggle("voice.deafen", { deafened: !snapshot.voice?.deafened })}>
      ◉<span>耳机</span>
    </button>
    <div className={snapshot.voice?.transmitting ? "voice-indicator active" : "voice-indicator"}>
      <span/>{snapshot.voice?.transmitting ? "正在发送" : `PTT ${shortcut}`}
    </div>
    <button className="control hangup" disabled={!snapshot.voice?.joined || busy} onClick={onLeave}>
      ×<span>断开</span>
    </button>
  </div>;
}
