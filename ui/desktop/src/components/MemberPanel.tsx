import { useState } from "react";
import type { Member } from "../bridge";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { InitialAvatar, Tooltip, cx } from "./ui";

const ROLE_LABELS: Record<string, string> = { owner: "所有者", admin: "管理员", guest: "访客" };

export default function MemberPanel({ members, loading, getName, onCopy }: {
  members: Member[];
  loading: boolean;
  getName: (userID: string) => string;
  onCopy: (text: string, label: string) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const onlineMembers = members.filter((member) => member.online);
  const offlineMembers = members.filter((member) => !member.online);

  function openMemberMenu(event: React.MouseEvent, member: Member) {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, items: [
      { label: "复制用户 ID", onSelect: () => onCopy(member.user_id, "用户 ID") },
      { label: "复制显示名", onSelect: () => onCopy(getName(member.user_id), "显示名") },
    ] });
  }

  function memberRow(member: Member, online: boolean) {
    const name = getName(member.user_id);
    return <li key={member.user_id} className={cx(
        "list-row items-center rounded-selector px-2 py-2 transition-colors hover:bg-base-200/60",
        !online && "text-base-content/45",
      )}
      onContextMenu={(event) => openMemberMenu(event, member)}>
      <Tooltip label={online ? "在线" : "离线"} side="left"><InitialAvatar name={name} size="sm" online={online} /></Tooltip>
      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
      {member.role !== "member" && <span className="badge badge-ghost badge-xs">{ROLE_LABELS[member.role] ?? member.role}</span>}
    </li>;
  }

  return <aside className="flex min-w-0 flex-col border-l border-base-300 bg-base-100">
    <header className="navbar min-h-16 shrink-0 border-b border-base-300 px-4">
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold">成员{loading ? "" : ` · ${members.length}`}</h2>
        {!loading && <p className="mt-0.5 text-xs text-base-content/45">{onlineMembers.length} 人在线</p>}
      </div>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {loading && members.length === 0
        ? <ul className="list">{[0, 1, 2].map((index) => <li key={index} className="list-row items-center px-2 py-2">
            <div className="skeleton h-8 w-8 rounded-full" />
            <div className="skeleton h-3" style={{ width: `${42 + index * 12}%` }} />
          </li>)}</ul>
        : <>
          {onlineMembers.length > 0 && <section>
            <h3 className="px-2 pb-1 pt-2 text-xs font-medium text-base-content/45">在线 — {onlineMembers.length}</h3>
            <ul className="list">{onlineMembers.map((member) => memberRow(member, true))}</ul>
          </section>}
          {offlineMembers.length > 0 && <section className={cx(onlineMembers.length > 0 && "mt-3")}>
            <h3 className="px-2 pb-1 pt-2 text-xs font-medium text-base-content/40">离线 — {offlineMembers.length}</h3>
            <ul className="list">{offlineMembers.map((member) => memberRow(member, false))}</ul>
          </section>}
        </>}
    </div>
    {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
  </aside>;
}
