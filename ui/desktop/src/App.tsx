import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { bridge, type AuthState, type LobbyEntry, type Member, type Profile, type Room, type Snapshot } from "./bridge";
import { parseOurCordLink, type OurCordLink } from "./deepLink";
import { loadVoicePrefs } from "./prefs";
import { createNameCache, displayName } from "./names";
import Login from "./components/Login";
import LobbyRail from "./components/LobbyRail";
import RoomPanel from "./components/RoomPanel";
import VoiceStage from "./components/VoiceStage";
import ChatPane from "./components/ChatPane";
import CallBar from "./components/CallBar";
import SettingsModal from "./components/SettingsModal";
import { LobbyRailSkeleton, RoomPanelSkeleton, Spinner } from "./components/Skeleton";

const PTT_SHORTCUT = "Ctrl+Shift+Space";
type InviteLink = Extract<OurCordLink, { kind: "invite" }>;

export default function App() {
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

  async function joinVoice(room: Room) {
    if (!room.vpn_namespace) return;
    setBusy(true); setConnectingRoomID(room.id); setSelectedRoomID(room.id); setError("");
    try {
      // Re-read the daemon state instead of trusting the 1 Hz poll: the join
      // decision (leave/connect/enter) must not race a stale snapshot.
      const fresh = await bridge<Snapshot>("daemon.snapshot");
      if (fresh.voice?.joined && fresh.status?.network_id === room.vpn_namespace) {
        return;
      }
      if (fresh.voice?.joined) await bridge("voice.leave");
      if (fresh.status?.network_id && fresh.status.network_id !== room.vpn_namespace) await bridge("network.leave");
      if (!fresh.status?.vpn_active) await bridge("network.connect");
      await bridge("network.enter", { network_id: room.vpn_namespace });
      const prefs = loadVoicePrefs();
      await bridge("voice.input_mode", { mode: prefs.mode, threshold_dbfs: prefs.threshold_dbfs, hangover_ms: prefs.hangover_ms });
      await bridge("voice.join");
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
      if (kind === "createLobby") { const name = prompt("大厅名称"); if (name) await bridge("lobbies.create", { name }); }
      if (kind === "joinLobby") { const lobby_id = prompt("大厅 ID"); const code = prompt("邀请码"); if (lobby_id && code) await bridge("lobbies.join", { lobby_id, code }); }
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
    const name = prompt(type === "text" ? "文字房间名称" : "语音房间名称");
    if (!name) return;
    try { await bridge("rooms.create", { lobby_id: selectedLobby.lobby.id, name, type }); await refreshLobbies(); }
    catch (e) { setError(String(e)); }
  }

  async function renameRoom(room: Room) {
    const name = prompt("新的房间名称", room.name);
    if (!name || name === room.name) return;
    try { await bridge("rooms.update", { room_id: room.id, name }); await refreshLobbies(); }
    catch (e) { setError(String(e)); }
  }

  async function deleteRoom(room: Room) {
    if (!confirm(`确定删除房间「${room.name}」？其中的消息与文件将一并删除。`)) return;
    try {
      await bridge("rooms.delete", { room_id: room.id });
      if (selectedRoomID === room.id) setSelectedRoomID("");
      await refreshLobbies();
    } catch (e) { setError(String(e)); }
  }

  if (auth.loading) return <div className="splash"><div className="brand-mark">O</div><p>正在连接安全客户端…</p></div>;
  if (!auth.authenticated) return <Login busy={busy} notice={notice} error={error} loginURLs={loginURLs} onMagic={(email) => void sendMagic(email)} />;

  if (!lobbiesLoaded) return <main className="app-shell">
    <LobbyRailSkeleton />
    <RoomPanelSkeleton />
    <section className="voice-stage"><div className="empty-state"><Spinner label="正在载入你的大厅…" /></div></section>
  </main>;

  const inVoice = !!snapshot.voice?.joined;
  const showChat = selectedRoom?.type === "text";
  const connecting = !!connectingRoomID && !inVoice;
  const stageTitle = selectedRoom ? (showChat ? `#${selectedRoom.name}` : selectedRoom.name) : "选择一个房间";

  return <main className="app-shell">
    <LobbyRail lobbies={lobbies} activeID={selectedLobby?.lobby.id ?? ""}
      onSelect={(id) => { setSelectedLobbyID(id); setSelectedRoomID(""); }}
      onCreate={() => void promptAction("createLobby")} onJoin={() => void promptAction("joinLobby")} />
    <RoomPanel lobby={selectedLobby} members={members} membersLoading={membersLoading} getName={getName}
      selectedRoomID={selectedRoomID} connectingRoomID={connectingRoomID}
      snapshot={snapshot} busy={busy} canManage={canManage} accountName={auth.profile?.user?.display_name}
      onSelectRoom={selectRoom} onCreateRoom={(type) => void createRoom(type)} onInvite={() => void promptAction("invite")}
      onRenameRoom={(room) => void renameRoom(room)} onDeleteRoom={(room) => void deleteRoom(room)}
      onOpenSettings={() => setSettings(true)} />
    <section className="voice-stage">
      <header className="stage-header">
        <div><span className="eyebrow">{showChat ? "文字房间" : "语音房间"}</span><h1>{stageTitle}</h1></div>
        <div className={`path-badge ${connecting ? "waiting" : snapshot.status?.path_summary ?? "inactive"}`}><span/>{connecting ? "连接中" : snapshot.status?.path_summary ?? "inactive"}</div>
      </header>
      {error && <div className="error-banner">{error}<button onClick={() => setError("")}>×</button></div>}
      {notice && !error && <div className="notice-banner">{notice}<button onClick={() => setNotice("")}>×</button></div>}
      {showChat && selectedRoom
        ? <ChatPane key={selectedRoom.id} room={selectedRoom} myUserID={myUserID} canModerate={canManage}
            getName={getName} ensureNames={ensureNames} onError={setError} />
        : connecting
          ? <div className="participants"><div className="empty-state"><div className="pulse-ring connecting">◖</div><h3>正在连接语音…</h3><p>建立加密隧道并协商最优路径。</p></div></div>
          : <VoiceStage snapshot={snapshot} />}
      {(inVoice || connecting || !showChat) && <CallBar snapshot={snapshot} busy={busy} shortcut={PTT_SHORTCUT}
        onLeave={() => void leaveVoice()} refresh={refreshSnapshot} onError={setError} />}
    </section>
    {settings && <SettingsModal snapshot={snapshot} auth={auth} close={() => setSettings(false)}
      refreshSnapshot={refreshSnapshot} refreshAuth={refreshAuth} onError={setError}
      logout={async () => { await bridge("auth.logout"); location.reload(); }} />}
  </main>;
}
