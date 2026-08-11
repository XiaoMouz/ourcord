import { bridge, type Snapshot } from "../bridge";
import { cx } from "./ui";

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
  return <div className="pointer-events-none absolute inset-x-0 bottom-5 z-10 flex justify-center">
    <div className="join pointer-events-auto rounded-field bg-base-200 shadow-2xl">
    <button className={cx("btn join-item tooltip tooltip-top", snapshot.voice?.muted && "btn-error btn-soft")} data-tip={snapshot.voice?.muted ? "取消静音" : "静音"}
      onClick={() => void toggle("voice.mute", { muted: !snapshot.voice?.muted })}>
      ⌁ <span>{snapshot.voice?.muted ? "取消静音" : "静音"}</span>
    </button>
    <button className={cx("btn join-item tooltip tooltip-top", snapshot.voice?.deafened && "btn-error btn-soft")} data-tip="切换耳机静音"
      onClick={() => void toggle("voice.deafen", { deafened: !snapshot.voice?.deafened })}>
      ◉ <span>耳机</span>
    </button>
    <div className="join-item flex min-w-36 items-center gap-2 border-x border-base-300 px-4 text-xs text-base-content/55">
      <span className={cx("status status-sm", snapshot.voice?.transmitting ? "status-success" : "status-neutral")} />
      {snapshot.voice?.transmitting ? "正在发送" : <><span>PTT</span><kbd className="kbd kbd-xs">{shortcut}</kbd></>}
    </div>
    <button className="btn btn-error btn-soft join-item tooltip tooltip-top" data-tip="断开语音"
      disabled={!snapshot.voice?.joined || busy} onClick={onLeave}>
      × <span>断开</span>
    </button>
    </div>
  </div>;
}
