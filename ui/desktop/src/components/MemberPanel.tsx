import { useState } from "react";
import type { Member } from "../bridge";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { InitialAvatar } from "./ui";

const ROLE_LABELS: Record<string, string> = { owner: "所有者", admin: "管理员", guest: "访客" };

export default function MemberPanel({ members, loading, getName, onCopy }: {
  members: Member[];
  loading: boolean;
  getName: (userID: string) => string;
  onCopy: (text: string, label: string) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  function openMemberMenu(event: React.MouseEvent, member: Member) {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, items: [
      { label: "复制用户 ID", onSelect: () => onCopy(member.user_id, "用户 ID") },
      { label: "复制显示名", onSelect: () => onCopy(getName(member.user_id), "显示名") },
    ] });
  }

  return <aside className="flex min-w-0 flex-col border-l border-base-300 bg-base-100">
    <header className="navbar min-h-16 shrink-0 border-b border-base-300 px-4">
      <h2 className="font-semibold">成员{loading ? "" : ` · ${members.length}`}</h2>
    </header>
    <ul className="list min-h-0 flex-1 overflow-y-auto p-2">
      {loading && members.length === 0
        ? [0, 1, 2].map((index) => <li key={index} className="list-row items-center px-2 py-2">
            <div className="skeleton h-8 w-8 rounded-full" />
            <div className="skeleton h-3" style={{ width: `${42 + index * 12}%` }} />
          </li>)
        : members.map((member) => <li key={member.user_id} className="list-row items-center px-2 py-2"
            onContextMenu={(event) => openMemberMenu(event, member)}>
            <InitialAvatar name={getName(member.user_id)} size="sm" />
            <span className="min-w-0 flex-1 truncate text-sm">{getName(member.user_id)}</span>
            {member.role !== "member" && <span className="badge badge-ghost badge-xs">{ROLE_LABELS[member.role] ?? member.role}</span>}
          </li>)}
    </ul>
    {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
  </aside>;
}
