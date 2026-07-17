// Shimmer placeholders shown on first load so the shell renders structure
// immediately (Discord-style) instead of flashing empty panels.

export function LobbyRailSkeleton() {
  return <nav className="lobby-rail">
    <div className="brand-mark small">O</div>
    {[0, 1, 2].map((i) => <div key={i} className="lobby skeleton-block" />)}
  </nav>;
}

export function RoomPanelSkeleton() {
  return <aside className="room-panel">
    <header><div><span className="eyebrow">大厅</span><div className="skeleton-line wide" /></div></header>
    <div className="room-scroll">
      <div className="section-title"><span>文字房间</span></div>
      <div className="room-list">{[0, 1].map((i) => <div key={i} className="skeleton-line room-skel" />)}</div>
      <div className="section-title"><span>语音房间</span></div>
      <div className="room-list">{[0, 1].map((i) => <div key={i} className="skeleton-line room-skel" />)}</div>
    </div>
  </aside>;
}

export function ChatSkeleton() {
  return <div className="chat-scroll">
    {[0, 1, 2, 3].map((i) => <div key={i} className="chat-message skeleton">
      <div className="chat-avatar skeleton-block" />
      <div className="chat-body">
        <div className="skeleton-line short" />
        <div className="skeleton-line" style={{ width: `${50 + (i % 3) * 15}%` }} />
      </div>
    </div>)}
  </div>;
}

export function Spinner({ label }: { label?: string }) {
  return <span className="spinner-wrap"><span className="spinner" />{label && <span>{label}</span>}</span>;
}
