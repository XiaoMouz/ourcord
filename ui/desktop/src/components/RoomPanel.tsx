import { useState } from "react";
import type { LobbyEntry, Member, Room, Snapshot } from "../bridge";
import { Spinner } from "./Skeleton";
import VoiceStatusBar from "./VoiceStatusBar";
import ContextMenu, { type MenuItem } from "./ContextMenu";
import { IconButton, InitialAvatar, Tooltip, cx } from "./ui";

type MenuState = { x: number; y: number; items: MenuItem[] };

export default function RoomPanel({ lobby, selectedRoomID, connectingRoomID, snapshot, members, getName, busy, canManage, accountName, onSelectRoom, onCreateRoom, onInvite, onRenameRoom, onDeleteRoom, onReorderRoom, onOpenSettings, onLeaveVoice, refreshSnapshot, onError, onCopy }: {
  lobby?: LobbyEntry;
  selectedRoomID: string;
  connectingRoomID: string;
  snapshot: Snapshot;
  members: Member[];
  getName: (userID: string) => string;
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
  const speakingKeys = new Set((snapshot.voice?.participants ?? []).filter((participant) => participant.speaking).map((participant) => participant.public_key));
  const speakingUsers = new Set((snapshot.peers ?? []).filter((peer) => speakingKeys.has(peer.public_key) && peer.user_id).map((peer) => peer.user_id));

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
    const selected = selectedRoomID === room.id;
    const voiceMembers = room.type === "voice"
      ? members.filter((member) => member.online && member.voice_room_id === room.id)
      : [];
    return <li key={room.id} className="mb-0.5">
      <div className={cx(
          "group/room relative flex min-h-9 min-w-0 items-center gap-2 rounded-selector px-2.5 text-sm text-base-content/65 transition-colors duration-150 hover:bg-base-200/70 hover:text-base-content",
          selected && "bg-base-300 font-medium text-base-content shadow-sm",
          busy && "pointer-events-none opacity-50",
        )}
        role="button" tabIndex={0} onClick={() => !busy && onSelectRoom(room)} onContextMenu={(e) => openRoomMenu(e, room)}
        onKeyDown={(e) => e.key === "Enter" && !busy && onSelectRoom(room)}>
        {selected && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-base-content/70" />}
        <span className="w-4 shrink-0 text-center text-base-content/40 transition-colors group-hover/room:text-base-content/70">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{room.name}</span>
        {connecting && <Spinner />}
        <span className="grid h-6 w-6 shrink-0 place-items-center">
          {live && !connecting && <Tooltip label="已加入" className={cx(canManage && "group-hover/room:hidden")}><span className="status status-success status-sm" /></Tooltip>}
          {canManage && <IconButton label="房间操作" className={cx("btn-xs opacity-0 transition-opacity group-hover/room:opacity-100 focus:opacity-100", live && "hidden group-hover/room:inline-flex")}
            onClick={(e) => { e.stopPropagation(); openRoomMenu(e, room); }}>⋯</IconButton>}
        </span>
      </div>
      {voiceMembers.length > 0 && <div className="ml-6 border-l border-base-300 py-1 pl-2"><ul className="list">
          {voiceMembers.map((member) => {
            const speaking = speakingUsers.has(member.user_id);
            return <li key={member.user_id} className="list-row min-h-8 items-center gap-2 px-2 py-1 text-xs text-base-content/60">
              <InitialAvatar name={getName(member.user_id)} size="sm" online />
              <span className={cx("min-w-0 flex-1 truncate", speaking && "font-medium text-base-content")}>{getName(member.user_id)}</span>
              {speaking && <Tooltip label="正在说话"><span className="status status-success status-xs" /></Tooltip>}
            </li>;
          })}
        </ul></div>}
    </li>;
  }

  return <aside className="flex min-w-0 flex-col border-r border-base-300 bg-base-100">
    <header className="navbar min-h-16 border-b border-base-300 px-4">
      <div className="min-w-0 flex-1"><h2 className="truncate font-semibold">{lobby?.lobby.name ?? "OurCord"}</h2></div>
      {lobby && canManage && <button className="btn btn-ghost btn-sm" onClick={onInvite}>邀请</button>}
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
      <div className="menu-title flex h-8 flex-row items-center justify-between px-2 text-xs font-medium text-base-content/45">
        <span>文字房间</span>{lobby && canManage && <IconButton label="新建文字房间" className="btn-xs" onClick={() => onCreateRoom("text")}>＋</IconButton>}
      </div>
      <ul className="menu menu-sm w-full p-0">
        {textRooms.map((room) => roomRow(room, "#"))}
        {textRooms.length === 0 && <li className="px-3 py-2 text-xs text-base-content/40">暂无房间</li>}
      </ul>
      <div className="menu-title mt-3 flex h-8 flex-row items-center justify-between px-2 text-xs font-medium text-base-content/45">
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
