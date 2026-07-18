import type { Snapshot } from "../bridge";
import { voiceQuality } from "../quality";
import SignalBars from "./SignalBars";

export default function VoiceStage({ snapshot }: { snapshot: Snapshot }) {
  const participants = snapshot.voice?.participants ?? [];
  return <div className="participants">
    {participants.map((participant) => {
      const peer = snapshot.peers?.find((p) => p.public_key === participant.public_key);
      const quality = voiceQuality(peer?.latency_ms ?? NaN, participant.loss_percent, participant.jitter_ms);
      const metrics = [
        peer && peer.latency_ms > 0 ? `${Math.round(peer.latency_ms)}ms` : null,
        participant.loss_percent > 0 ? `丢包 ${participant.loss_percent.toFixed(1)}%` : null,
        `抖动 ${Math.round(participant.jitter_ms)}ms`,
      ].filter(Boolean).join(" · ");
      return <article key={participant.public_key} className={participant.speaking ? "participant speaking" : "participant"}>
        <div className="participant-avatar">{(peer?.display_name || peer?.name || "?").slice(0, 1).toUpperCase()}</div>
        <div className="participant-info">
          <strong>{peer?.display_name || peer?.name || "未知成员"}
            {participant.secure && <span className="secure-badge" title="端到端加密">🔒</span>}
            {peer?.flapping && <span className="flap-badge" title="路径抖动">⚠</span>}
          </strong>
          <span>{metrics}</span>
        </div>
        <SignalBars quality={quality} title={metrics} />
      </article>;
    })}
    {snapshot.voice?.joined && participants.length === 0 && <div className="empty-state">
      <div className="pulse-ring">◖</div>
      <h3>已进入房间</h3>
      <p>等待其他成员加入。你的连接已准备好。</p>
    </div>}
    {!snapshot.voice?.joined && <div className="empty-state">
      <div className="pulse-ring">◎</div>
      <h3>{snapshot.daemon_available ? "选一个房间开始通话" : "后台服务未运行"}</h3>
      <p>{snapshot.daemon_available ? "在左侧选择语音房间加入。" : "请重新启动 OurCord 或检查 Windows 服务。"}</p>
    </div>}
  </div>;
}
