export function LobbyRailSkeleton() {
  return <nav className="flex flex-col items-center gap-3 border-r border-base-300 bg-base-200 px-3 py-4">
    <div className="skeleton h-11 w-11 rounded-box" />
    <div className="divider my-0" />
    {[0, 1, 2].map((i) => <div key={i} className="skeleton h-11 w-11 rounded-box" />)}
  </nav>;
}

export function RoomPanelSkeleton() {
  return <aside className="flex min-w-0 flex-col border-r border-base-300 bg-base-100">
    <header className="border-b border-base-300 p-4">
      <div className="skeleton h-4 w-32" />
    </header>
    <div className="flex-1 space-y-6 overflow-hidden p-3">
      {[0, 1].map((group) => <div key={group} className="space-y-2">
        <div className="skeleton h-3 w-20" />
        {[0, 1].map((i) => <div key={i} className="skeleton h-9 w-full" />)}
      </div>)}
    </div>
  </aside>;
}

export function ChatSkeleton() {
  return <div className="flex-1 space-y-6 overflow-hidden p-6">
    {[0, 1, 2, 3].map((i) => <div key={i} className="flex gap-3">
      <div className="skeleton h-9 w-9 shrink-0 rounded-selector" />
      <div className="flex-1 space-y-2">
        <div className="skeleton h-3 w-28" />
        <div className="skeleton h-5" style={{ width: `${50 + (i % 3) * 15}%` }} />
      </div>
    </div>)}
  </div>;
}

export function Spinner({ label }: { label?: string }) {
  return <span className="inline-flex items-center gap-2 text-sm text-base-content/60">
    <span className="loading loading-spinner loading-sm" />{label && <span>{label}</span>}
  </span>;
}
