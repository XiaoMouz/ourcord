import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { bridge, type AuthState, type LobbyEntry, type Member, type Profile, type Room, type Snapshot } from "./bridge";
import { parseOurCordLink, type OurCordLink } from "./deepLink";
import { loadVoicePrefs } from "./prefs";
import { createNameCache, displayName } from "./names";
import { useDialog } from "./dialog";
import { remainingCooldownSeconds } from "./cooldown";
import Login from "./components/Login";
import LobbyRail from "./components/LobbyRail";
import RoomPanel from "./components/RoomPanel";
import MemberPanel from "./components/MemberPanel";
import VoiceStage from "./components/VoiceStage";
import ChatPane from "./components/ChatPane";
import CallBar from "./components/CallBar";
import SettingsModal from "./components/SettingsModal";
import DiagnosticsModal from "./components/DiagnosticsModal";
import { LobbyRailSkeleton, MemberPanelSkeleton, RoomPanelSkeleton, Spinner } from "./components/Skeleton";
import { EmptyState, ToastHost, cx, type ToastMessage } from "./components/ui";
import TitleBar from "./components/TitleBar";
import { installDesktopUpdate, retryDesktopUpdate, useDesktopUpdater } from "./updater";

const PTT_SHORTCUT = "Ctrl+Shift+Space";
type InviteLink = Extract<OurCordLink, { kind: "invite" }>;

export default function App() {
  const dialog = useDialog();
  const [auth, setAuth] = useState<AuthState>({ loading: true, authenticated: false });
  const [authError, setAuthError] = useState("");
  const authRequestRef = useRef(0);
  const [loginURLs, setLoginURLs] = useState<{ google_url: string; github_url: string }>();
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const toastID = useRef(0);
  const showToast = useCallback((message: string, tone: ToastMessage["tone"]) => {
    toastID.current += 1;
    setToast({ id: toastID.current, message, tone });
  }, []);
  const showNotice = useCallback((message: string) => showToast(message, "success"), [showToast]);
  const showError = useCallback((message: string) => showToast(message, "error"), [showToast]);
  const dismissToast = useCallback(() => setToast(null), []);
  const [magicRetryUntil, setMagicRetryUntil] = useState(0);
  const [magicCooldownSeconds, setMagicCooldownSeconds] = useState(0);
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
  const updater = useDesktopUpdater();

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
  const memberLobbyRef = useRef("");
  memberLobbyRef.current = auth.authenticated ? selectedLobby?.lobby.id ?? "" : "";
  const memberRequestRef = useRef(0);
  const selectedRoom = selectedLobby?.rooms.find((room) => room.id === selectedRoomID);
  const canManage = !!selectedLobby && ["owner", "admin"].includes(selectedLobby.member.role);
  const myUserID = auth.profile?.user?.id ?? "";
  const activeVoiceRoomID = snapshot.voice?.joined
    ? lobbies.flatMap((entry) => entry.rooms).find((room) => room.vpn_namespace === snapshot.status?.network_id)?.id ?? ""
    : "";

  const refreshAuth = useCallback(async () => {
    const requestID = ++authRequestRef.current;
    setAuthError("");
    try {
      const state = await bridge<AuthState>("auth.status");
      if (requestID !== authRequestRef.current) return;
      // Login actions need the persisted PKCE verifier, so publish the login
      // screen only after setup succeeds. Newer auth checks supersede this one.
      const urls = state.authenticated ? undefined : await bridge<{ google_url: string; github_url: string }>("auth.begin");
      if (requestID !== authRequestRef.current) return;
      setLoginURLs(urls);
      setAuth({ ...state, loading: false });
    } catch (error) {
      if (requestID !== authRequestRef.current) return;
      setAuthError(String(error));
      throw error;
    }
  }, []);
  const retryStartup = useCallback(() => {
    // The startup screen renders the error; event handlers elsewhere surface
    // refreshAuth failures through their existing notifications.
    void refreshAuth().catch(() => {});
  }, [refreshAuth]);
  const lobbyRequestRef = useRef(0);
  const refreshLobbies = useCallback(async () => {
    const requestID = ++lobbyRequestRef.current;
    try {
      const data = await bridge<{ lobbies: LobbyEntry[] }>("lobbies.list");
      // A post-mutation refresh must supersede older polling snapshots.
      if (requestID !== lobbyRequestRef.current) return;
      setLobbies(data.lobbies);
      setSelectedLobbyID((current) => current || data.lobbies[0]?.lobby.id || "");
    } catch (error) {
      if (requestID === lobbyRequestRef.current) throw error;
    } finally {
      if (requestID === lobbyRequestRef.current) setLobbiesLoaded(true);
    }
  }, []);
  const snapshotRequestRef = useRef(0);
  const snapshotAppliedRef = useRef(0);
  const refreshSnapshot = useCallback(async () => {
    const requestID = ++snapshotRequestRef.current;
    try {
      const data = await bridge<Snapshot>("daemon.snapshot");
      // Keep successful snapshots ordered without starving a slow read just
      // because another request has started in the meantime.
      if (requestID <= snapshotAppliedRef.current) return;
      snapshotAppliedRef.current = requestID;
      setSnapshot(data);
    } catch (error) {
      if (requestID > snapshotAppliedRef.current) throw error;
    }
  }, []);
  const refreshMembers = useCallback(async (lobbyID: string, showLoading = false) => {
    if (lobbyID !== memberLobbyRef.current) return;
    const requestID = ++memberRequestRef.current;
    const isCurrent = () => requestID === memberRequestRef.current && lobbyID === memberLobbyRef.current;
    if (!lobbyID) { setMembers([]); return; }
    if (showLoading) setMembersLoading(true);
    try {
      const data = await bridge<{ members: Member[] }>("lobbies.members", { lobby_id: lobbyID });
      if (!isCurrent()) return;
      setMembers(data.members ?? []);
      void ensureNames((data.members ?? []).map((member) => member.user_id));
    } catch { if (isCurrent()) setMembers([]); }
    finally { if (isCurrent()) setMembersLoading(false); }
  }, [ensureNames]);
  const syncPresence = useCallback(async () => {
    await bridge("presence.update", { voice_room_id: activeVoiceRoomID });
  }, [activeVoiceRoomID]);

  const applyInvite = useCallback(async (invite: InviteLink) => {
    try {
      await bridge("lobbies.join", { lobby_id: invite.lobbyID, code: invite.code });
      await refreshLobbies();
      setSelectedLobbyID(invite.lobbyID);
      showNotice("已加入大厅");
    } catch (e) { showError(String(e)); }
  }, [refreshLobbies, showError, showNotice]);

  const handleDeepLink = useCallback(async (raw: string) => {
    const link = parseOurCordLink(raw);
    if (!link) { showError("链接无效"); return; }
    if (link.kind === "auth") {
      setBusy(true);
      try { await bridge("auth.exchange", { code: link.code }); await refreshAuth(); }
      catch (e) { showError(String(e)); }
      finally { setBusy(false); }
      return;
    }
    // Invites arriving before login are queued and applied after auth instead
    // of silently failing against an unauthenticated bridge.
    if (!authRef.current.authenticated) {
      setPendingInvite(link);
      showNotice("登录后将自动加入邀请的大厅");
      return;
    }
    await applyInvite(link);
  }, [applyInvite, refreshAuth, showError, showNotice]);

  useEffect(() => {
    retryStartup();
    return () => { authRequestRef.current += 1; };
  }, [retryStartup]);
  useEffect(() => {
    if (!auth.authenticated || !pendingInvite) return;
    setPendingInvite(null);
    void applyInvite(pendingInvite);
  }, [auth.authenticated, pendingInvite, applyInvite]);
  useEffect(() => {
    void getCurrent().then((urls) => urls?.forEach((url) => void handleDeepLink(url)));
    let dispose: undefined | (() => void);
    void onOpenUrl((urls) => urls.forEach((url) => void handleDeepLink(url))).then((fn) => { dispose = fn; });
    return () => dispose?.();
  }, [handleDeepLink]);
  useEffect(() => {
    if (!auth.authenticated) return;
    let snapshotPolling = false;
    const pollSnapshot = async () => {
      if (snapshotPolling) return;
      snapshotPolling = true;
      try { await refreshSnapshot(); }
      catch { /* Keep the last snapshot until the next successful poll. */ }
      finally { snapshotPolling = false; }
    };
    void refreshLobbies().catch((error) => showError(String(error)));
    void pollSnapshot();
    const lobbyTimer = window.setInterval(() => void refreshLobbies().catch(() => {}), 30_000);
    const daemonTimer = window.setInterval(() => void pollSnapshot(), 1_000);
    return () => {
      lobbyRequestRef.current += 1;
      snapshotAppliedRef.current = ++snapshotRequestRef.current;
      clearInterval(lobbyTimer); clearInterval(daemonTimer);
    };
  }, [auth.authenticated, refreshLobbies, refreshSnapshot, showError]);
  useEffect(() => {
    if (!auth.authenticated) return;
    const lobbyID = selectedLobby?.lobby.id ?? "";
    let cancelled = false;
    setMembers([]); // clear stale rows so the switch shows a loader, not the old lobby
    setMembersLoading(!!lobbyID);
    const refreshPresence = async (showLoading = false) => {
      try { await syncPresence(); } catch { /* TTL handles transient service failures */ }
      if (cancelled) return;
      await refreshMembers(lobbyID, showLoading);
    };
    void refreshPresence(true);
    const timer = window.setInterval(() => void refreshPresence(), 30_000);
    return () => {
      cancelled = true;
      memberRequestRef.current += 1;
      clearInterval(timer);
    };
  }, [auth.authenticated, selectedLobby?.lobby.id, refreshMembers, syncPresence]);
  useEffect(() => {
    if (!magicRetryUntil) { setMagicCooldownSeconds(0); return; }
    const update = () => {
      const seconds = remainingCooldownSeconds(magicRetryUntil);
      setMagicCooldownSeconds(seconds);
      if (seconds === 0) setMagicRetryUntil(0);
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [magicRetryUntil]);
  useEffect(() => {
    if (!auth.authenticated) return;
    register(PTT_SHORTCUT, (event) => void bridge("voice.ptt", { pressed: event.state === "Pressed" }).catch(() => {}))
      .catch(() => showToast(`PTT 快捷键 ${PTT_SHORTCUT} 注册失败，可能被其他应用占用`, "warning"));
    return () => { void unregister(PTT_SHORTCUT); };
  }, [auth.authenticated, showToast]);

  async function sendMagic(email: string) {
    setBusy(true);
    try {
      const result = await bridge<{ sent: boolean; expires_in: number; retry_after: number }>("auth.magic", { email });
      const retryAfter = Math.max(1, result.retry_after || 60);
      setMagicRetryUntil(Date.now() + retryAfter * 1000);
      showNotice("登录链接已发送，请在这台电脑上打开邮件并确认。");
    } catch (e) { showError(String(e)); } finally { setBusy(false); }
  }

  const copyText = useCallback(async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); showNotice(`${label}已复制`); }
    catch { showError("复制失败"); }
  }, [showError, showNotice]);

  async function joinVoice(room: Room) {
    if (!room.vpn_namespace) return;
    setBusy(true); setConnectingRoomID(room.id); setSelectedRoomID(room.id);
    try {
      // The leave/connect/enter/join orchestration lives in the client core
      // (JoinVoiceNetwork); the presenter only supplies the persisted prefs.
      const prefs = loadVoicePrefs();
      await bridge("voice.join_network", { network_id: room.vpn_namespace, mode: prefs.mode, threshold_dbfs: prefs.threshold_dbfs, hangover_ms: prefs.hangover_ms });
      await refreshSnapshot();
      await bridge("presence.update", { voice_room_id: room.id }).catch(() => undefined);
      if (selectedLobby) await refreshMembers(selectedLobby.lobby.id);
    } catch (e) { showError(String(e)); } finally { setBusy(false); setConnectingRoomID(""); }
  }

  async function leaveVoice() {
    setBusy(true);
    try {
      await bridge("voice.leave");
      await bridge("network.leave");
      await bridge("presence.update", { voice_room_id: "" }).catch(() => undefined);
      await refreshSnapshot();
      if (selectedLobby) await refreshMembers(selectedLobby.lobby.id);
      if (selectedRoom?.type === "voice") setSelectedRoomID("");
    } catch (e) { showError(String(e)); } finally { setBusy(false); }
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
        showNotice("邀请链接已复制");
      }
      await refreshLobbies();
    } catch (e) { showError(String(e)); }
  }

  async function createRoom(type: "text" | "voice") {
    if (!selectedLobby) return;
    const name = await dialog.promptText(type === "text" ? "新建文字房间" : "新建语音房间", { label: "房间名称", required: true, maxLength: 80 });
    if (!name) return;
    try { await bridge("rooms.create", { lobby_id: selectedLobby.lobby.id, name, type }); await refreshLobbies(); }
    catch (e) { showError(String(e)); }
  }

  async function renameRoom(room: Room) {
    const name = await dialog.promptText("重命名房间", { label: "房间名称", initial: room.name, required: true, maxLength: 80 });
    if (!name || name === room.name) return;
    try { await bridge("rooms.update", { room_id: room.id, name }); await refreshLobbies(); }
    catch (e) { showError(String(e)); }
  }

  async function deleteRoom(room: Room) {
    const ok = await dialog.confirm({ title: `删除房间「${room.name}」`, message: "其中的消息与文件将一并删除，无法恢复。", confirmLabel: "删除", danger: true });
    if (!ok) return;
    try {
      await bridge("rooms.delete", { room_id: room.id });
      if (selectedRoomID === room.id) setSelectedRoomID("");
      await refreshLobbies();
    } catch (e) { showError(String(e)); }
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
    } catch (e) { showError(String(e)); }
  }

  const titleBar = <TitleBar update={updater}
    onInstall={() => void installDesktopUpdate().catch(() => showError("更新安装失败"))}
    onRetry={() => void retryDesktopUpdate().catch(() => showError("更新下载失败"))} />;

  if (auth.loading) return <div className="flex h-screen min-w-[920px] flex-col bg-base-300 text-base-content">{titleBar}<div className="hero min-h-0 flex-1"><div className="flex flex-col items-center gap-4">
    <div className="avatar avatar-placeholder"><div className="h-16 w-16 rounded-box bg-neutral text-neutral-content"><span className="text-2xl font-semibold">O</span></div></div>
    {authError ? <>
      <div role="alert" className="alert max-w-lg">
        <div><h1 className="font-semibold">暂时无法启动 OurCord</h1>
          <p className="mt-1 text-sm">请检查网络连接后重试。如果问题持续，请重新打开应用。</p>
          <p className="mt-2 break-all text-sm">{authError}</p>
        </div>
      </div>
      <button className="btn" onClick={retryStartup}>重试</button>
    </> : <Spinner label="正在启动 OurCord" />}
  </div></div></div>;
  if (!auth.authenticated) return <div className="flex h-screen min-w-[920px] flex-col bg-base-200 text-base-content">{titleBar}<div className="min-h-0 flex-1">
    <Login busy={busy} cooldownSeconds={magicCooldownSeconds} loginURLs={loginURLs} onMagic={(email) => void sendMagic(email)} />
    <ToastHost toast={toast} onDismiss={dismissToast} />
  </div></div>;

  if (!lobbiesLoaded) return <div className="flex h-screen min-w-[920px] flex-col bg-base-300 text-base-content">{titleBar}<div className="min-h-0 flex-1">
    <main className="grid h-full grid-cols-[4.5rem_17rem_minmax(0,1fr)_15rem]">
      <LobbyRailSkeleton />
      <RoomPanelSkeleton />
      <section className="hero bg-base-200"><Spinner label="正在载入大厅" /></section>
      <MemberPanelSkeleton />
    </main>
    <ToastHost toast={toast} onDismiss={dismissToast} />
  </div></div>;

  const inVoice = !!snapshot.voice?.joined;
  const showChat = selectedRoom?.type === "text";
  const connecting = !!connectingRoomID && !inVoice;
  const stageTitle = selectedRoom ? (showChat ? `#${selectedRoom.name}` : selectedRoom.name) : "选择一个房间";
  const path = connecting ? "waiting" : snapshot.status?.path_summary ?? "inactive";

  return <div className="flex h-screen min-w-[920px] flex-col bg-base-300 text-base-content">{titleBar}<main className="grid min-h-0 flex-1 grid-cols-[4.5rem_17rem_minmax(0,1fr)_15rem]">
    <LobbyRail lobbies={lobbies} activeID={selectedLobby?.lobby.id ?? ""}
      onSelect={(id) => { setSelectedLobbyID(id); setSelectedRoomID(""); }}
      onCreate={() => void promptAction("createLobby")} onJoin={() => void promptAction("joinLobby")} />
    <RoomPanel lobby={selectedLobby}
      selectedRoomID={selectedRoomID} connectingRoomID={connectingRoomID}
      snapshot={snapshot} members={members} getName={getName} busy={busy} canManage={canManage} accountName={auth.profile?.user?.display_name}
      onSelectRoom={selectRoom} onCreateRoom={(type) => void createRoom(type)} onInvite={() => void promptAction("invite")}
      onRenameRoom={(room) => void renameRoom(room)} onDeleteRoom={(room) => void deleteRoom(room)}
      onReorderRoom={(room, dir) => void reorderRoom(room, dir)}
      onOpenSettings={() => setSettings(true)} onLeaveVoice={() => void leaveVoice()}
      refreshSnapshot={refreshSnapshot} onError={showError} onCopy={(text, label) => void copyText(text, label)} />
    <section className="relative flex min-w-0 flex-col overflow-hidden bg-base-200">
      <header className="navbar min-h-16 shrink-0 border-b border-base-300 bg-base-100 px-5">
        <div className="min-w-0 flex-1"><h1 className="truncate text-lg font-semibold">{stageTitle}</h1></div>
        <div className={cx("badge badge-sm gap-2", path === "direct" ? "badge-success badge-soft" : path === "derp" || path === "next-hop" ? "badge-warning badge-soft" : path === "waiting" ? "badge-primary badge-soft" : "badge-ghost")}>
          <span className={cx("status status-xs", path === "direct" ? "status-success" : path === "derp" || path === "next-hop" ? "status-warning" : path === "waiting" ? "status-primary" : "status-neutral")} />
          {connecting ? "连接中" : path}
        </div>
      </header>
      {showChat && selectedRoom
        ? <ChatPane key={selectedRoom.id} room={selectedRoom} myUserID={myUserID} canModerate={canManage}
            getName={getName} ensureNames={ensureNames} onError={showError} onNotice={showNotice}
            onCopy={(text, label) => void copyText(text, label)} />
        : connecting
          ? <div className="flex-1"><EmptyState icon={<span className="loading loading-ring loading-lg" />} title="正在连接语音" /></div>
          : <VoiceStage snapshot={snapshot} selfName={auth.profile?.user?.display_name} />}
      {(inVoice || connecting || !showChat) && <CallBar snapshot={snapshot} busy={busy} shortcut={PTT_SHORTCUT}
        onLeave={() => void leaveVoice()} refresh={refreshSnapshot} onError={showError} />}
    </section>
    <MemberPanel members={members} loading={membersLoading} getName={getName}
      onCopy={(text, label) => void copyText(text, label)} />
    {settings && <SettingsModal snapshot={snapshot} auth={auth} close={() => setSettings(false)}
      refreshSnapshot={refreshSnapshot} refreshAuth={refreshAuth} onError={showError} onNotice={showNotice}
      openDiagnostics={() => { setSettings(false); setDiagnostics(true); }}
      logout={async () => { await bridge("auth.logout"); location.reload(); }} />}
    {diagnostics && <DiagnosticsModal snapshot={snapshot} close={() => setDiagnostics(false)} onError={showError} />}
  </main><ToastHost toast={toast} onDismiss={dismissToast} /></div>;
}
