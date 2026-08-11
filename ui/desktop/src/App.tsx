import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { bridge, type AuthState, type LobbyEntry, type Member, type Profile, type Room, type Snapshot } from "./bridge";
import { parseOurCordLink, type OurCordLink } from "./deepLink";
import { loadVoicePrefs } from "./prefs";
import { createNameCache, displayName } from "./names";
import { useDialog } from "./dialog";
import Login from "./components/Login";
import LobbyRail from "./components/LobbyRail";
import RoomPanel from "./components/RoomPanel";
import VoiceStage from "./components/VoiceStage";
import ChatPane from "./components/ChatPane";
import CallBar from "./components/CallBar";
import SettingsModal from "./components/SettingsModal";
import DiagnosticsModal from "./components/DiagnosticsModal";
import { LobbyRailSkeleton, RoomPanelSkeleton, Spinner } from "./components/Skeleton";
import { EmptyState, IconButton, cx } from "./components/ui";

const PTT_SHORTCUT = "Ctrl+Shift+Space";
type InviteLink = Extract<OurCordLink, { kind: "invite" }>;

export default function App() {
  const dialog = useDialog();
  const [auth, setAuth] = useState<AuthState>({ loading: true, authenticated: false });
  const [loginURLs, setLoginURLs] = useState<{ google_url: string; github_url: string }>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [lobbies, setLobbies] = useState<LobbyEntry[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [selectedLobbyID, setSelectedLobbyID] = useState("");
  const [selectedRoomID, setSelectedRoomID] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>({ daemon_available: false });
  const [settings, setSettings] = useState(false);
  const [diagnostics, setDiagnostics] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lobbiesLoaded, setLobbiesLoaded] = useState(false);
  const [membersLoading, setMembersLoading] = useState(false);
  const [connectingRoomID, setConnectingRoomID] = useState("");
  const [pendingInvite, setPendingInvite] = useState<InviteLink | null>(null);
  const [, setNameTick] = useState(0);

  const names = useRef(createNameCache(async (ids) => {
    const data = await bridge<{ profiles: Profile[] }>("profiles.lookup", { user_ids: ids });
    return data.profiles ?? [];
  })).current;
  const ensureNames = useCallback(async (ids: string[]) => {
    if (await names.ensure(ids)) setNameTick((tick) => tick + 1);
  }, [names]);
  const getName = useCallback((id: string) => displayName(names, id), [names]);

  const authRef = useRef(auth);
  authRef.current = auth;

  const selectedLobby = lobbies.find((entry) => entry.lobby.id === selectedLobbyID) ?? lobbies[0];
  const selectedRoom = selectedLobby?.rooms.find((room) => room.id === selectedRoomID);
  const canManage = !!selectedLobby && ["owner", "admin"].includes(selectedLobby.member.role);
  const myUserID = auth.profile?.user?.id ?? "";

  const refreshAuth = useCallback(async () => {
    const state = await bridge<AuthState>("auth.status");
    setAuth({ ...state, loading: false });
    if (!state.authenticated) setLoginURLs(await bridge("auth.begin"));
  }, []);
  const refreshLobbies = useCallback(async () => {
    try {
      const data = await bridge<{ lobbies: LobbyEntry[] }>("lobbies.list");
      setLobbies(data.lobbies);
      setSelectedLobbyID((current) => current || data.lobbies[0]?.lobby.id || "");
    } finally {
      setLobbiesLoaded(true);
    }
  }, []);
  const refreshSnapshot = useCallback(async () => setSnapshot(await bridge<Snapshot>("daemon.snapshot")), []);
  const refreshMembers = useCallback(async (lobbyID: string, showLoading = false) => {
    if (!lobbyID) { setMembers([]); return; }
    if (showLoading) setMembersLoading(true);
    try {
      const data = await bridge<{ members: Member[] }>("lobbies.members", { lobby_id: lobbyID });
      setMembers(data.members ?? []);
      void ensureNames((data.members ?? []).map((member) => member.user_id));
    } catch { setMembers([]); }
    finally { setMembersLoading(false); }
  }, [ensureNames]);

  const applyInvite = useCallback(async (invite: InviteLink) => {
    try {
      await bridge("lobbies.join", { lobby_id: invite.lobbyID, code: invite.code });
      await refreshLobbies();
      setSelectedLobbyID(invite.lobbyID);
      setNotice("已加入大厅");
    } catch (e) { setError(String(e)); }
  }, [refreshLobbies]);

  const handleDeepLink = useCallback(async (raw: string) => {
    const link = parseOurCordLink(raw);
    if (!link) { setError("链接无效"); return; }
    if (link.kind === "auth") {
      setBusy(true);
      try { await bridge("auth.exchange", { code: link.code }); await refreshAuth(); }
      catch (e) { setError(String(e)); }
      finally { setBusy(false); }
      return;
    }
    // Invites arriving before login are queued and applied after auth instead
    // of silently failing against an unauthenticated bridge.
    if (!authRef.current.authenticated) {
      setPendingInvite(link);
      setNotice("登录后将自动加入邀请的大厅");
      return;
    }
    await applyInvite(link);
  }, [applyInvite, refreshAuth]);

  useEffect(() => { void refreshAuth(); }, [refreshAuth]);
  useEffect(() => {
    if (!auth.authenticated || !pendingInvite) return;
    setPendingInvite(null);
    void applyInvite(pendingInvite);
  }, [auth.authenticated, pendingInvite, applyInvite]);
  useEffect(() => {
    async function checkForUpdate() {
      try {
        const update = await check();
        if (update && confirm(`OurCord ${update.version} 已可用，是否现在更新？`)) {
          await update.downloadAndInstall();
          await relaunch();
        }
      } catch { /* updater is intentionally inactive in unsigned dev builds */ }
    }
    void checkForUpdate();
    const timer = window.setInterval(() => void checkForUpdate(), 6 * 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    void getCurrent().then((urls) => urls?.forEach((url) => void handleDeepLink(url)));
    let dispose: undefined | (() => void);
    void onOpenUrl((urls) => urls.forEach((url) => void handleDeepLink(url))).then((fn) => { dispose = fn; });
    return () => dispose?.();
  }, [handleDeepLink]);
  useEffect(() => {
    if (!auth.authenticated) return;
    void refreshLobbies(); void refreshSnapshot();
    const lobbyTimer = window.setInterval(() => void refreshLobbies(), 30_000);
    const daemonTimer = window.setInterval(() => void refreshSnapshot(), 1_000);
    return () => { clearInterval(lobbyTimer); clearInterval(daemonTimer); };
  }, [auth.authenticated, refreshLobbies, refreshSnapshot]);
  useEffect(() => {
    if (!auth.authenticated) return;
    const lobbyID = selectedLobby?.lobby.id ?? "";
    setMembers([]); // clear stale rows so the switch shows a loader, not the old lobby
    void refreshMembers(lobbyID, true);
    const timer = window.setInterval(() => void refreshMembers(lobbyID), 60_000);
    return () => clearInterval(timer);
  }, [auth.authenticated, selectedLobby?.lobby.id, refreshMembers]);
  useEffect(() => {
    if (!auth.authenticated) return;
    register(PTT_SHORTCUT, (event) => void bridge("voice.ptt", { pressed: event.state === "Pressed" }).catch(() => {}))
      .catch(() => setNotice(`PTT 快捷键 ${PTT_SHORTCUT} 注册失败，可能被其他应用占用`));
    return () => { void unregister(PTT_SHORTCUT); };
  }, [auth.authenticated]);

  async function sendMagic(email: string) {
    setError(""); setBusy(true);
    try { await bridge("auth.magic", { email }); setNotice("登录链接已发送，请在这台电脑上打开邮件并确认。"); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  const copyText = useCallback(async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); setNotice(`${label}已复制`); }
    catch { setError("复制失败"); }
  }, []);

  async function joinVoice(room: Room) {
    if (!room.vpn_namespace) return;
    setBusy(true); setConnectingRoomID(room.id); setSelectedRoomID(room.id); setError("");
    try {
      // The leave/connect/enter/join orchestration lives in the client core
      // (JoinVoiceNetwork); the presenter only supplies the persisted prefs.
      const prefs = loadVoicePrefs();
      await bridge("voice.join_network", { network_id: room.vpn_namespace, mode: prefs.mode, threshold_dbfs: prefs.threshold_dbfs, hangover_ms: prefs.hangover_ms });
      await refreshSnapshot();
    } catch (e) { setError(String(e)); } finally { setBusy(false); setConnectingRoomID(""); }
  }

  async function leaveVoice() {
    setBusy(true); setError("");
    try {
      await bridge("voice.leave");
      await bridge("network.leave");
      await refreshSnapshot();
      if (selectedRoom?.type === "voice") setSelectedRoomID("");
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }

  function selectRoom(room: Room) {
    if (room.type === "voice") void joinVoice(room);
    else setSelectedRoomID(room.id);
  }

  async function promptAction(kind: "createLobby" | "joinLobby" | "invite") {
    try {
      if (kind === "createLobby") {
        const name = await dialog.promptText("创建大厅", { label: "大厅名称", placeholder: "例如：周末开黑", required: true, maxLength: 80 });
        if (name) await bridge("lobbies.create", { name });
      }
      if (kind === "joinLobby") {
        const values = await dialog.prompt({ title: "加入大厅", fields: [
          { name: "lobby_id", label: "大厅 ID", required: true },
          { name: "code", label: "邀请码", required: true },
        ] });
        if (values) await bridge("lobbies.join", { lobby_id: values.lobby_id, code: values.code });
      }
      if (kind === "invite" && selectedLobby) {
        const result = await bridge<{ code: string }>("lobbies.invite", { lobby_id: selectedLobby.lobby.id });
        await navigator.clipboard.writeText(`ourcord://invite?lobby_id=${selectedLobby.lobby.id}&code=${result.code}`);
        setNotice("邀请链接已复制");
      }
      await refreshLobbies();
    } catch (e) { setError(String(e)); }
  }

  async function createRoom(type: "text" | "voice") {
    if (!selectedLobby) return;
    const name = await dialog.promptText(type === "text" ? "新建文字房间" : "新建语音房间", { label: "房间名称", required: true, maxLength: 80 });
    if (!name) return;
    try { await bridge("rooms.create", { lobby_id: selectedLobby.lobby.id, name, type }); await refreshLobbies(); }
    catch (e) { setError(String(e)); }
  }

  async function renameRoom(room: Room) {
    const name = await dialog.promptText("重命名房间", { label: "房间名称", initial: room.name, required: true, maxLength: 80 });
    if (!name || name === room.name) return;
    try { await bridge("rooms.update", { room_id: room.id, name }); await refreshLobbies(); }
    catch (e) { setError(String(e)); }
  }

  async function deleteRoom(room: Room) {
    const ok = await dialog.confirm({ title: `删除房间「${room.name}」`, message: "其中的消息与文件将一并删除，无法恢复。", confirmLabel: "删除", danger: true });
    if (!ok) return;
    try {
      await bridge("rooms.delete", { room_id: room.id });
      if (selectedRoomID === room.id) setSelectedRoomID("");
      await refreshLobbies();
    } catch (e) { setError(String(e)); }
  }

  // reorderRoom swaps a room with its same-type neighbor by writing the
  // neighbor's position onto it (service orders rooms by position).
  async function reorderRoom(room: Room, direction: -1 | 1) {
    if (!selectedLobby) return;
    const siblings = selectedLobby.rooms.filter((r) => r.type === room.type).sort((a, b) => a.position - b.position);
    const index = siblings.findIndex((r) => r.id === room.id);
    const target = siblings[index + direction];
    if (!target) return;
    try {
      await bridge("rooms.update", { room_id: room.id, position: target.position });
      await bridge("rooms.update", { room_id: target.id, position: room.position });
      await refreshLobbies();
    } catch (e) { setError(String(e)); }
  }

  if (auth.loading) return <div className="hero min-h-screen bg-base-300"><div className="flex flex-col items-center gap-4">
    <div className="avatar avatar-placeholder"><div className="h-16 w-16 rounded-box bg-neutral text-neutral-content"><span className="text-2xl font-semibold">O</span></div></div>
    <Spinner label="正在启动 OurCord" />
  </div></div>;
  if (!auth.authenticated) return <Login busy={busy} notice={notice} error={error} loginURLs={loginURLs} onMagic={(email) => void sendMagic(email)} />;

  if (!lobbiesLoaded) return <main className="grid h-screen min-w-[800px] grid-cols-[4.5rem_17rem_minmax(0,1fr)] bg-base-300 text-base-content">
    <LobbyRailSkeleton />
    <RoomPanelSkeleton />
    <section className="hero bg-base-200"><Spinner label="正在载入大厅" /></section>
  </main>;

  const inVoice = !!snapshot.voice?.joined;
  const showChat = selectedRoom?.type === "text";
  const connecting = !!connectingRoomID && !inVoice;
  const stageTitle = selectedRoom ? (showChat ? `#${selectedRoom.name}` : selectedRoom.name) : "选择一个房间";
  const path = connecting ? "waiting" : snapshot.status?.path_summary ?? "inactive";

  return <main className="grid h-screen min-w-[800px] grid-cols-[4.5rem_17rem_minmax(0,1fr)] bg-base-300 text-base-content">
    <LobbyRail lobbies={lobbies} activeID={selectedLobby?.lobby.id ?? ""}
      onSelect={(id) => { setSelectedLobbyID(id); setSelectedRoomID(""); }}
      onCreate={() => void promptAction("createLobby")} onJoin={() => void promptAction("joinLobby")} />
    <RoomPanel lobby={selectedLobby} members={members} membersLoading={membersLoading} getName={getName}
      selectedRoomID={selectedRoomID} connectingRoomID={connectingRoomID}
      snapshot={snapshot} busy={busy} canManage={canManage} accountName={auth.profile?.user?.display_name}
      onSelectRoom={selectRoom} onCreateRoom={(type) => void createRoom(type)} onInvite={() => void promptAction("invite")}
      onRenameRoom={(room) => void renameRoom(room)} onDeleteRoom={(room) => void deleteRoom(room)}
      onReorderRoom={(room, dir) => void reorderRoom(room, dir)}
      onOpenSettings={() => setSettings(true)} onLeaveVoice={() => void leaveVoice()}
      refreshSnapshot={refreshSnapshot} onError={setError} onCopy={(text, label) => void copyText(text, label)} />
    <section className="relative flex min-w-0 flex-col overflow-hidden bg-base-200">
      <header className="navbar min-h-16 shrink-0 border-b border-base-300 bg-base-100 px-5">
        <div className="min-w-0 flex-1"><h1 className="truncate text-lg font-semibold">{stageTitle}</h1></div>
        <div className={cx("badge badge-sm gap-2", path === "direct" ? "badge-success badge-soft" : path === "derp" || path === "next-hop" ? "badge-warning badge-soft" : path === "waiting" ? "badge-primary badge-soft" : "badge-ghost")}>
          <span className={cx("status status-xs", path === "direct" ? "status-success" : path === "derp" || path === "next-hop" ? "status-warning" : path === "waiting" ? "status-primary" : "status-neutral")} />
          {connecting ? "连接中" : path}
        </div>
      </header>
      {error && <div className="alert alert-error alert-soft m-3 mb-0 shrink-0 py-2 text-sm"><span className="min-w-0 flex-1 break-words">{error}</span><IconButton label="关闭错误" className="btn-xs" onClick={() => setError("")}>×</IconButton></div>}
      {notice && !error && <div className="alert alert-success alert-soft m-3 mb-0 shrink-0 py-2 text-sm"><span className="min-w-0 flex-1 break-words">{notice}</span><IconButton label="关闭通知" className="btn-xs" onClick={() => setNotice("")}>×</IconButton></div>}
      {showChat && selectedRoom
        ? <ChatPane key={selectedRoom.id} room={selectedRoom} myUserID={myUserID} canModerate={canManage}
            getName={getName} ensureNames={ensureNames} onError={setError} onNotice={setNotice}
            onCopy={(text, label) => void copyText(text, label)} />
        : connecting
          ? <div className="flex-1"><EmptyState icon={<span className="loading loading-ring loading-lg" />} title="正在连接语音" /></div>
          : <VoiceStage snapshot={snapshot} selfName={auth.profile?.user?.display_name} />}
      {(inVoice || connecting || !showChat) && <CallBar snapshot={snapshot} busy={busy} shortcut={PTT_SHORTCUT}
        onLeave={() => void leaveVoice()} refresh={refreshSnapshot} onError={setError} />}
    </section>
    {settings && <SettingsModal snapshot={snapshot} auth={auth} close={() => setSettings(false)}
      refreshSnapshot={refreshSnapshot} refreshAuth={refreshAuth} onError={setError}
      openDiagnostics={() => { setSettings(false); setDiagnostics(true); }}
      logout={async () => { await bridge("auth.logout"); location.reload(); }} />}
    {diagnostics && <DiagnosticsModal snapshot={snapshot} close={() => setDiagnostics(false)} onError={setError} />}
  </main>;
}
