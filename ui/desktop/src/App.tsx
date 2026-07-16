import { useCallback, useEffect, useMemo, useState } from "react";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { bridge, type LobbyEntry, type Room, type Snapshot } from "./bridge";
import { parseOurCordLink } from "./deepLink";

type AuthState = { loading: boolean; authenticated: boolean; profile?: { user?: { display_name: string; email: string } } };
const PTT_SHORTCUT = "Ctrl+Shift+Space";

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ loading: true, authenticated: false });
  const [loginURLs, setLoginURLs] = useState<{ google_url: string; github_url: string }>();
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [lobbies, setLobbies] = useState<LobbyEntry[]>([]);
  const [selectedLobbyID, setSelectedLobbyID] = useState("");
  const [selectedRoomID, setSelectedRoomID] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>({ daemon_available: false });
  const [settings, setSettings] = useState(false);
  const [busy, setBusy] = useState(false);

  const selectedLobby = lobbies.find((entry) => entry.lobby.id === selectedLobbyID) ?? lobbies[0];
  const voiceRooms = useMemo(() => selectedLobby?.rooms.filter((room) => room.type === "voice") ?? [], [selectedLobby]);
  const selectedRoom = voiceRooms.find((room) => room.id === selectedRoomID);

  const refreshAuth = useCallback(async () => {
    const state = await bridge<AuthState>("auth.status");
    setAuth({ ...state, loading: false });
    if (!state.authenticated) setLoginURLs(await bridge("auth.begin"));
  }, []);
  const refreshLobbies = useCallback(async () => {
    const data = await bridge<{ lobbies: LobbyEntry[] }>("lobbies.list");
    setLobbies(data.lobbies);
    setSelectedLobbyID((current) => current || data.lobbies[0]?.lobby.id || "");
  }, []);
  const refreshSnapshot = useCallback(async () => setSnapshot(await bridge<Snapshot>("daemon.snapshot")), []);

  const handleDeepLink = useCallback(async (raw: string) => {
    const link = parseOurCordLink(raw);
    if (!link) { setError("链接无效"); return; }
    if (link.kind === "auth") {
      setBusy(true);
      try { await bridge("auth.exchange", { code: link.code }); await refreshAuth(); }
      catch (e) { setError(String(e)); }
      finally { setBusy(false); }
    }
    if (link.kind === "invite") {
      await bridge("lobbies.join", { lobby_id: link.lobbyID, code: link.code }); await refreshLobbies();
    }
  }, [refreshAuth, refreshLobbies]);

  useEffect(() => { void refreshAuth(); }, [refreshAuth]);
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
    void register(PTT_SHORTCUT, (event) => void bridge("voice.ptt", { pressed: event.state === "Pressed" }).catch(() => {}));
    return () => { void unregister(PTT_SHORTCUT); };
  }, [auth.authenticated]);

  async function sendMagic() {
    setError(""); setBusy(true);
    try { await bridge("auth.magic", { email }); setNotice("登录链接已发送，请在这台电脑上打开邮件并确认。"); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function joinVoice(room: Room) {
    if (!room.vpn_namespace) return;
    setBusy(true); setError("");
    try {
      if (snapshot.voice?.joined) await bridge("voice.leave");
      if (snapshot.status?.network_id && snapshot.status.network_id !== room.vpn_namespace) await bridge("network.leave");
      if (!snapshot.status?.vpn_active) await bridge("network.connect");
      await bridge("network.enter", { network_id: room.vpn_namespace });
      await bridge("voice.input_mode", { mode: "voice_activity", threshold_dbfs: -45, hangover_ms: 300 });
      await bridge("voice.join"); setSelectedRoomID(room.id); await refreshSnapshot();
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function leaveVoice() { setBusy(true); try { await bridge("voice.leave"); await bridge("network.leave"); await refreshSnapshot(); setSelectedRoomID(""); } finally { setBusy(false); } }
  async function promptAction(kind: "createLobby" | "joinLobby" | "createRoom" | "invite") {
    try {
      if (kind === "createLobby") { const name = prompt("大厅名称"); if (name) await bridge("lobbies.create", { name }); }
      if (kind === "joinLobby") { const lobby_id = prompt("大厅 ID"); const code = prompt("邀请码"); if (lobby_id && code) await bridge("lobbies.join", { lobby_id, code }); }
      if (kind === "createRoom" && selectedLobby) { const name = prompt("语音房间名称"); if (name) await bridge("rooms.create", { lobby_id: selectedLobby.lobby.id, name }); }
      if (kind === "invite" && selectedLobby) { const result = await bridge<{ code: string }>("lobbies.invite", { lobby_id: selectedLobby.lobby.id }); await navigator.clipboard.writeText(`ourcord://invite?lobby_id=${selectedLobby.lobby.id}&code=${result.code}`); setNotice("邀请链接已复制"); }
      await refreshLobbies();
    } catch (e) { setError(String(e)); }
  }

  if (auth.loading) return <div className="splash"><div className="brand-mark">O</div><p>正在连接安全客户端…</p></div>;
  if (!auth.authenticated) return <main className="login-shell"><section className="login-card"><div className="brand"><div className="brand-mark">O</div><div><h1>OurCord</h1><p>属于你们的小群体网络</p></div></div><h2>欢迎回来</h2><p className="muted">使用邮箱链接或已有账号继续。令牌只会保存在系统凭据库中。</p><label>邮箱地址<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" onKeyDown={(e) => e.key === "Enter" && void sendMagic()} /></label><button className="primary" disabled={busy || !email.includes("@")} onClick={() => void sendMagic()}>发送 Magic Link</button><div className="divider"><span>或</span></div><div className="oauth"><button disabled={!loginURLs} onClick={() => loginURLs && void openUrl(loginURLs.google_url)}>G&nbsp; 使用 Google</button><button disabled={!loginURLs} onClick={() => loginURLs && void openUrl(loginURLs.github_url)}>⌁&nbsp; 使用 GitHub</button></div>{notice && <p className="notice">{notice}</p>}{error && <p className="error">{error}</p>}</section><aside className="login-art"><div className="mesh"><i/><i/><i/><i/></div><h2>P2P 优先，保持自治。</h2><p>语音穿过你自己的加密覆盖网络，直连失败时才使用中继。</p></aside></main>;

  const participants = snapshot.voice?.participants ?? [];
  return <main className="app-shell">
    <nav className="lobby-rail"><div className="brand-mark small">O</div>{lobbies.map(({ lobby }) => <button key={lobby.id} className={selectedLobby?.lobby.id === lobby.id ? "lobby active" : "lobby"} onClick={() => { setSelectedLobbyID(lobby.id); setSelectedRoomID(""); }} title={lobby.name}>{lobby.name.slice(0, 2).toUpperCase()}</button>)}<button className="lobby add" onClick={() => void promptAction("createLobby")}>+</button><button className="lobby add" onClick={() => void promptAction("joinLobby")}>↗</button></nav>
    <aside className="room-panel"><header><div><span className="eyebrow">大厅</span><h2>{selectedLobby?.lobby.name ?? "创建一个大厅"}</h2></div>{selectedLobby && <button className="icon-button" onClick={() => void promptAction("invite")}>邀请</button>}</header><div className="section-title"><span>语音房间</span>{selectedLobby && ["owner","admin"].includes(selectedLobby.member.role) && <button onClick={() => void promptAction("createRoom")}>＋</button>}</div><div className="room-list">{voiceRooms.map((room) => <button key={room.id} className={selectedRoomID === room.id ? "room active" : "room"} onClick={() => void joinVoice(room)} disabled={busy}><span className="room-icon">◖</span>{room.name}{snapshot.voice?.joined && snapshot.status?.network_id === room.vpn_namespace && <span className="live-dot"/>}</button>)}{voiceRooms.length === 0 && <p className="empty">还没有语音房间</p>}</div><footer className="account"><div className="avatar">{auth.profile?.user?.display_name?.slice(0,1).toUpperCase() ?? "U"}</div><div><strong>{auth.profile?.user?.display_name ?? "OurCord 用户"}</strong><small>{snapshot.daemon_available ? "daemon 已连接" : "daemon 离线"}</small></div><button onClick={() => setSettings(true)}>⚙</button></footer></aside>
    <section className="voice-stage"><header className="stage-header"><div><span className="eyebrow">语音房间</span><h1>{selectedRoom?.name ?? "选择一个语音房间"}</h1></div><div className={`path-badge ${snapshot.status?.path_summary ?? "inactive"}`}><span/>{snapshot.status?.path_summary ?? "inactive"}</div></header>{error && <div className="error-banner">{error}<button onClick={() => setError("")}>×</button></div>}<div className="participants">{participants.map((participant) => { const peer = snapshot.peers?.find((p) => p.public_key === participant.public_key); return <article key={participant.public_key} className={participant.speaking ? "participant speaking" : "participant"}><div className="participant-avatar">{(peer?.display_name || peer?.name || "?").slice(0,1).toUpperCase()}</div><div><strong>{peer?.display_name || peer?.name || "未知成员"}</strong><span>{peer?.name && peer.display_name ? peer.name : peer?.path}{participant.secure ? " · 端到端加密" : ""}</span></div><div className="quality">{Math.round(participant.jitter_ms)}ms</div></article>; })}{snapshot.voice?.joined && participants.length === 0 && <div className="empty-state"><div className="pulse-ring">◖</div><h3>已进入房间</h3><p>等待其他成员加入。你的连接已准备好。</p></div>}{!snapshot.voice?.joined && <div className="empty-state"><div className="pulse-ring">◎</div><h3>{snapshot.daemon_available ? "选一个房间开始通话" : "后台服务未运行"}</h3><p>{snapshot.daemon_available ? "语音将优先通过 P2P 加密隧道传输。" : "请重新启动 OurCord 或检查 Windows 服务。"}</p></div>}</div><div className="call-bar"><button className={snapshot.voice?.muted ? "control danger" : "control"} onClick={() => void bridge("voice.mute", { muted: !snapshot.voice?.muted }).then(refreshSnapshot)}>⌁<span>{snapshot.voice?.muted ? "取消静音" : "静音"}</span></button><button className={snapshot.voice?.deafened ? "control danger" : "control"} onClick={() => void bridge("voice.deafen", { deafened: !snapshot.voice?.deafened }).then(refreshSnapshot)}>◉<span>耳机</span></button><div className={snapshot.voice?.transmitting ? "voice-indicator active" : "voice-indicator"}><span/>{snapshot.voice?.transmitting ? "正在发送" : `PTT ${PTT_SHORTCUT}`}</div><button className="control hangup" disabled={!snapshot.voice?.joined || busy} onClick={() => void leaveVoice()}>×<span>断开</span></button></div></section>
    {settings && <Settings snapshot={snapshot} close={() => setSettings(false)} refresh={refreshSnapshot} logout={async () => { await bridge("auth.logout"); location.reload(); }} />}
  </main>;
}

function Settings({ snapshot, close, refresh, logout }: { snapshot: Snapshot; close: () => void; refresh: () => Promise<void>; logout: () => Promise<void> }) {
  const [mode, setMode] = useState(snapshot.voice?.input_mode || "voice_activity");
  const [threshold, setThreshold] = useState(-45);
  async function apply() { await bridge("voice.input_mode", { mode, threshold_dbfs: threshold, hangover_ms: 300 }); await refresh(); }
  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}><section className="settings"><header><div><span className="eyebrow">OurCord</span><h2>设置与诊断</h2></div><button onClick={close}>×</button></header><div className="settings-grid"><label>输入模式<select value={mode} onChange={(e) => setMode(e.target.value)}><option value="voice_activity">语音激活</option><option value="push_to_talk">按键说话</option><option value="open_mic">开放麦</option></select></label><label>激活阈值 <strong>{threshold} dBFS</strong><input type="range" min="-60" max="-20" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}/></label><button className="primary" onClick={() => void apply()}>应用语音设置</button><div className="diagnostics"><h3>网络诊断</h3><dl><div><dt>daemon</dt><dd>{snapshot.daemon_available ? "可用" : "离线"}</dd></div><div><dt>VPN</dt><dd>{snapshot.status?.vpn_active ? "已连接" : "未连接"}</dd></div><div><dt>路径</dt><dd>{snapshot.status?.path_summary ?? "inactive"}</dd></div><div><dt>路径切换</dt><dd>{snapshot.status?.path_flaps_total ?? 0}</dd></div><div><dt>Peer</dt><dd>{snapshot.peers?.length ?? 0}</dd></div></dl></div><button className="secondary danger-text" onClick={() => void logout()}>退出账号</button></div></section></div>;
}
