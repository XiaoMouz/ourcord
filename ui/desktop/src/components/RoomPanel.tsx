import type { LobbyEntry, Member, Room, Snapshot } from "../bridge";
import { Spinner } from "./Skeleton";
import VoiceStatusBar from "./VoiceStatusBar";

const ROLE_LABELS: Record<string, string> = { owner: "所有者", admin: "管理员", guest: "访客" };

export default function RoomPanel({ lobby, members, membersLoading, getName, selectedRoomID, connectingRoomID, snapshot, busy, canManage, accountName, onSelectRoom, onCreateRoom, onInvite, onRenameRoom, onDeleteRoom, onOpenSettings, onLeaveVoice, refreshSnapshot, onError }: {
  lobby?: LobbyEntry;
  members: Member[];
  membersLoading: boolean;
  getName: (userID: string) => string;
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
  onOpenSettings: () => void;
  onLeaveVoice: () => void;
  refreshSnapshot: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const rooms = lobby?.rooms ?? [];
  const textRooms = rooms.filter((room) => room.type === "text");
  const voiceRooms = rooms.filter((room) => room.type === "voice");

  function roomRow(room: Room, icon: string) {
    const live = room.type === "voice" && snapshot.voice?.joined && snapshot.status?.network_id === room.vpn_namespace;
    const connecting = room.id === connectingRoomID;
    const className = selectedRoomID === room.id ? "room active" : "room";
    return <div key={room.id} className={busy ? className + " disabled" : className} role="button" tabIndex={0}
      onClick={() => !busy && onSelectRoom(room)}
      onKeyDown={(e) => e.key === "Enter" && !busy && onSelectRoom(room)}>
      <span className="room-icon">{icon}</span>
      <span className="room-name">{room.name}</span>
      {connecting && <span className="room-status"><Spinner /></span>}
      {live && !connecting && <span className="live-dot"/>}
      {canManage && <span className="manage">
        <button title="重命名" onClick={(e) => { e.stopPropagation(); onRenameRoom(room); }}>✎</button>
        <button title="删除房间" onClick={(e) => { e.stopPropagation(); onDeleteRoom(room); }}>×</button>
      </span>}
    </div>;
  }

  return <aside className="room-panel">
    <header>
      <div><span className="eyebrow">大厅</span><h2>{lobby?.lobby.name ?? "创建一个大厅"}</h2></div>
      {lobby && canManage && <button className="icon-button" onClick={onInvite}>邀请</button>}
    </header>
    <div className="room-scroll">
      <div className="section-title"><span>文字房间</span>{lobby && canManage && <button title="新建文字房间" onClick={() => onCreateRoom("text")}>＋</button>}</div>
      <div className="room-list">
        {textRooms.map((room) => roomRow(room, "#"))}
        {textRooms.length === 0 && <p className="empty">还没有文字房间</p>}
      </div>
      <div className="section-title"><span>语音房间</span>{lobby && canManage && <button title="新建语音房间" onClick={() => onCreateRoom("voice")}>＋</button>}</div>
      <div className="room-list">
        {voiceRooms.map((room) => roomRow(room, "◖"))}
        {voiceRooms.length === 0 && <p className="empty">还没有语音房间</p>}
      </div>
      <div className="section-title"><span>成员{membersLoading ? "" : ` · ${members.length}`}</span></div>
      <div className="member-list">
        {membersLoading && members.length === 0
          ? [0, 1, 2].map((i) => <div key={i} className="member"><div className="member-avatar skeleton-block" /><span className="skeleton-line" style={{ width: `${40 + i * 12}%` }} /></div>)
          : members.map((member) => <div key={member.user_id} className="member">
              <div className="member-avatar">{getName(member.user_id).slice(0, 1).toUpperCase()}</div>
              <span className="member-name">{getName(member.user_id)}</span>
              {member.role !== "member" && <em>{ROLE_LABELS[member.role] ?? member.role}</em>}
            </div>)}
      </div>
    </div>
    <VoiceStatusBar snapshot={snapshot} connecting={!!connectingRoomID && !snapshot.voice?.joined}
      busy={busy} onLeave={onLeaveVoice} refresh={refreshSnapshot} onError={onError} />
    <footer className="account">
      <div className="avatar">{accountName?.slice(0, 1).toUpperCase() ?? "U"}</div>
      <div><strong>{accountName ?? "OurCord 用户"}</strong><small>{snapshot.daemon_available ? "daemon 已连接" : "daemon 离线"}</small></div>
      <button title="设置" onClick={onOpenSettings}>⚙</button>
    </footer>
  </aside>;
}
