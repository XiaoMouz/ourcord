import type { Snapshot } from "../bridge";
import { voiceQuality } from "../quality";
import SignalBars from "./SignalBars";
import { EmptyState, InitialAvatar, Tooltip, cx } from "./ui";

export default function VoiceStage({ snapshot, selfName }: { snapshot: Snapshot; selfName?: string }) {
  const participants = snapshot.voice?.participants ?? [];
  const voice = snapshot.voice;
  return <div className="voice-stage">
    {voice?.joined && <article className={cx("voice-seat", voice.local_speaking && !voice.muted && "border-success ring-2 ring-success/20")}>
      <div className="seat-body">
      <InitialAvatar name={selfName || "我"} size="lg" online={voice.local_speaking && !voice.muted} />
      <div className="min-w-0 max-w-full">
        <strong className="block truncate">{selfName ? `${selfName}（你）` : "你"}</strong>
        {(voice.muted || voice.local_speaking) && <span className={cx("badge badge-sm mt-1", voice.muted ? "badge-error badge-soft" : "badge-success badge-soft")}>
          {voice.muted ? "已静音" : "说话中"}
        </span>}
      </div>
      </div>
    </article>}
    {participants.map((participant) => {
      const peer = snapshot.peers?.find((p) => p.public_key === participant.public_key);
      const quality = voiceQuality(peer?.latency_ms ?? NaN, participant.loss_percent, participant.jitter_ms);
      const metrics = [
        peer && peer.latency_ms > 0 ? `${Math.round(peer.latency_ms)}ms` : null,
        participant.loss_percent > 0 ? `丢包 ${participant.loss_percent.toFixed(1)}%` : null,
        `抖动 ${Math.round(participant.jitter_ms)}ms`,
      ].filter(Boolean).join(" · ");
      const peerName = peer?.display_name || "未知成员";
      return <article key={participant.public_key} className={cx("voice-seat", participant.speaking && "border-success ring-2 ring-success/20")}>
        <div className="seat-body">
        <InitialAvatar name={peerName} size="lg" online={participant.speaking} />
        <div className="min-w-0 max-w-full">
          <strong className="flex flex-wrap justify-center items-center gap-1">{peerName}
            {participant.secure && <Tooltip label="端到端加密"><span className="badge badge-success badge-soft badge-xs">加密</span></Tooltip>}
            {peer?.flapping && <Tooltip label="路径抖动"><span className="badge badge-warning badge-soft badge-xs">抖动</span></Tooltip>}
          </strong>
          {participant.speaking && <small>说话中</small>}
          <span className="mt-1 block truncate text-xs text-base-content/50">{metrics}</span>
        </div>
        <SignalBars quality={quality} title={metrics} />
        </div>
      </article>;
    })}
    {snapshot.voice?.joined && participants.length === 0 && <div className="col-span-full text-center text-sm text-base-content/70">等待其他成员加入</div>}
    {!snapshot.voice?.joined && !snapshot.daemon_available && <div className="col-span-full flex min-h-[55vh] items-center justify-center">
      <div role="alert" className="alert alert-warning">
        <span className="status status-warning" />
        <span>后台服务不可用，正在重试。</span>
      </div>
    </div>}
    {!snapshot.voice?.joined && snapshot.daemon_available && <div className="col-span-full min-h-[55vh]"><EmptyState icon="◎" title="选择语音房间" /></div>}
  </div>;
}
