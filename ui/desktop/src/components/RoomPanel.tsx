import { useState } from "react";
import type { LobbyEntry, Room, Snapshot } from "../bridge";
import { Spinner } from "./Skeleton";
import VoiceStatusBar from "./VoiceStatusBar";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { IconButton, InitialAvatar, Tooltip, cx } from "./ui";

type MenuState = { x: number; y: number; items: MenuItem[] };

export default function RoomPanel({ lobby, selectedRoomID, connectingRoomID, snapshot, busy, canManage, accountName, onSelectRoom, onCreateRoom, onInvite, onRenameRoom, onDeleteRoom, onReorderRoom, onOpenSettings, onLeaveVoice, refreshSnapshot, onError, onCopy }: {
  lobby?: LobbyEntry;
  selectedRoomID: string;
  connectingRoomID: string;
  snapshot: Snapshot;
  busy: boolean;
  canManage: boolean;
  accountName?: string;
  onSelectRoom: (room: Room) => void;
  onCreateRoom: (type: "text" | "voice") => void;
  onInvite: () => void;
  onRenameRoom: (room: Room) => void;
  onDeleteRoom: (room: Room) => void;
  onReorderRoom: (room: Room, direction: -1 | 1) => void;
  onOpenSettings: () => void;
  onLeaveVoice: () => void;
  refreshSnapshot: () => Promise<void>;
  onError: (message: string) => void;
  onCopy: (text: string, label: string) => void;
}) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const rooms = lobby?.rooms ?? [];
  const byPosition = (a: Room, b: Room) => a.position - b.position;
  const textRooms = rooms.filter((room) => room.type === "text").sort(byPosition);
  const voiceRooms = rooms.filter((room) => room.type === "voice").sort(byPosition);

  function openRoomMenu(e: React.MouseEvent, room: Room) {
    e.preventDefault();
    const siblings = rooms.filter((r) => r.type === room.type).sort((a, b) => a.position - b.position);
    const index = siblings.findIndex((r) => r.id === room.id);
    const items: MenuItem[] = [{ label: "复制房间 ID", onSelect: () => onCopy(room.id, "房间 ID") }];
    if (canManage) items.push(
      { label: "上移", disabled: index <= 0, onSelect: () => onReorderRoom(room, -1) },
      { label: "下移", disabled: index >= siblings.length - 1, onSelect: () => onReorderRoom(room, 1) },
      { label: "重命名", onSelect: () => onRenameRoom(room) },
      { label: "删除房间", danger: true, onSelect: () => onDeleteRoom(room) },
    );
    setMenu({ x: e.clientX, y: e.clientY, items });
  }
  function roomRow(room: Room, icon: string) {
    const live = room.type === "voice" && snapshot.voice?.joined && snapshot.status?.network_id === room.vpn_namespace;
    const connecting = room.id === connectingRoomID;
    return <li key={room.id}>
      <div className={cx("group flex min-w-0 items-center gap-2", selectedRoomID === room.id && "menu-active", busy && "pointer-events-none opacity-50")}
        role="button" tabIndex={0} onClick={() => !busy && onSelectRoom(room)} onContextMenu={(e) => openRoomMenu(e, room)}
        onKeyDown={(e) => e.key === "Enter" && !busy && onSelectRoom(room)}>
        <span className="w-4 shrink-0 text-center text-base-content/45">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{room.name}</span>
        {connecting && <Spinner />}
        {live && !connecting && <Tooltip label="已加入"><span className="status status-success status-sm" /></Tooltip>}
        {canManage && <span className="hidden shrink-0 items-center group-hover:flex">
          <IconButton label="重命名房间" className="btn-xs" onClick={(e) => { e.stopPropagation(); onRenameRoom(room); }}>✎</IconButton>
          <IconButton label="删除房间" className="btn-xs text-error" onClick={(e) => { e.stopPropagation(); onDeleteRoom(room); }}>×</IconButton>
        </span>}
      </div>
    </li>;
  }

  return <aside className="flex min-w-0 flex-col border-r border-base-300 bg-base-100">
    <header className="navbar min-h-16 border-b border-base-300 px-4">
      <div className="min-w-0 flex-1"><h2 className="truncate font-semibold">{lobby?.lobby.name ?? "OurCord"}</h2></div>
      {lobby && canManage && <button className="btn btn-ghost btn-sm" onClick={onInvite}>邀请</button>}
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
      <div className="flex h-8 items-center justify-between px-2 text-xs font-semibold uppercase tracking-wide text-base-content/45">
        <span>文字房间</span>{lobby && canManage && <IconButton label="新建文字房间" className="btn-xs" onClick={() => onCreateRoom("text")}>＋</IconButton>}
      </div>
      <ul className="menu menu-sm w-full p-0">
        {textRooms.map((room) => roomRow(room, "#"))}
        {textRooms.length === 0 && <li className="px-3 py-2 text-xs text-base-content/40">暂无房间</li>}
      </ul>
      <div className="mt-3 flex h-8 items-center justify-between px-2 text-xs font-semibold uppercase tracking-wide text-base-content/45">
        <span>语音房间</span>{lobby && canManage && <IconButton label="新建语音房间" className="btn-xs" onClick={() => onCreateRoom("voice")}>＋</IconButton>}
      </div>
      <ul className="menu menu-sm w-full p-0">
        {voiceRooms.map((room) => roomRow(room, "◖"))}
        {voiceRooms.length === 0 && <li className="px-3 py-2 text-xs text-base-content/40">暂无房间</li>}
      </ul>
    </div>
    <VoiceStatusBar snapshot={snapshot} connecting={!!connectingRoomID && !snapshot.voice?.joined}
      busy={busy} onLeave={onLeaveVoice} refresh={refreshSnapshot} onError={onError} />
    <footer className="flex items-center gap-3 border-t border-base-300 bg-base-200 px-3 py-3">
      <InitialAvatar name={accountName ?? "OurCord 用户"} size="sm" online={snapshot.daemon_available} />
      <div className="min-w-0 flex-1"><strong className="block truncate text-sm">{accountName ?? "OurCord 用户"}</strong><small className="block text-xs text-base-content/45">{snapshot.daemon_available ? "后台服务在线" : "后台服务离线"}</small></div>
      <IconButton label="设置" onClick={onOpenSettings}>⚙</IconButton>
    </footer>
    {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
  </aside>;
}
