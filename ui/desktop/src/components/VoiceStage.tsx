import type { Snapshot } from "../bridge";

export default function VoiceStage({ snapshot }: { snapshot: Snapshot }) {
  const participants = snapshot.voice?.participants ?? [];
  return <div className="participants">
    {participants.map((participant) => {
      const peer = snapshot.peers?.find((p) => p.public_key === participant.public_key);
      return <article key={participant.public_key} className={participant.speaking ? "participant speaking" : "participant"}>
        <div className="participant-avatar">{(peer?.display_name || peer?.name || "?").slice(0, 1).toUpperCase()}</div>
        <div>
          <strong>{peer?.display_name || peer?.name || "未知成员"}</strong>
          <span>{peer?.name && peer.display_name ? peer.name : peer?.path}{participant.secure ? " · 端到端加密" : ""}</span>
        </div>
        <div className="quality">{Math.round(participant.jitter_ms)}ms</div>
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
      <p>{snapshot.daemon_available ? "语音将优先通过 P2P 加密隧道传输。" : "请重新启动 OurCord 或检查 Windows 服务。"}</p>
    </div>}
  </div>;
}
