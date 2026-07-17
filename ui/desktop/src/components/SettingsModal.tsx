import { useEffect, useState } from "react";
import { bridge, type AudioDevice, type AuthState, type Snapshot } from "../bridge";
import { loadVoicePrefs, saveVoicePrefs, type VoiceMode } from "../prefs";

type DeviceLists = { capture: AudioDevice[]; playback: AudioDevice[] };

export default function SettingsModal({ snapshot, auth, close, refreshSnapshot, refreshAuth, logout, onError }: {
  snapshot: Snapshot;
  auth: AuthState;
  close: () => void;
  refreshSnapshot: () => Promise<void>;
  refreshAuth: () => Promise<void>;
  logout: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [prefs, setPrefs] = useState(() => loadVoicePrefs());
  const [devices, setDevices] = useState<DeviceLists>();
  const [devicesError, setDevicesError] = useState("");
  const [captureID, setCaptureID] = useState("");
  const [playbackID, setPlaybackID] = useState("");
  const [name, setName] = useState(auth.profile?.user?.display_name ?? "");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const lists = await bridge<DeviceLists>("voice.devices");
        if (cancelled) return;
        setDevices({ capture: lists.capture ?? [], playback: lists.playback ?? [] });
        setCaptureID((lists.capture ?? []).find((d) => d.is_default)?.id ?? "");
        setPlaybackID((lists.playback ?? []).find((d) => d.is_default)?.id ?? "");
      } catch (e) {
        if (!cancelled) setDevicesError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function applyVoice() {
    try {
      saveVoicePrefs(prefs);
      await bridge("voice.input_mode", { mode: prefs.mode, threshold_dbfs: prefs.threshold_dbfs, hangover_ms: prefs.hangover_ms });
      await refreshSnapshot();
      setNotice("语音设置已应用");
    } catch (e) { onError(String(e)); }
  }

  async function applyDevices() {
    try {
      await bridge("voice.set_devices", { capture_id: captureID, playback_id: playbackID });
      setNotice("音频设备已切换");
    } catch (e) { onError(String(e)); }
  }

  async function saveName() {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await bridge("profile.update", { display_name: trimmed });
      await refreshAuth();
      setNotice("显示名已更新");
    } catch (e) { onError(String(e)); }
  }

  async function disconnectVPN() {
    try {
      await bridge("network.disconnect");
      await refreshSnapshot();
      setNotice("VPN 已断开");
    } catch (e) { onError(String(e)); }
  }

  const deviceUnsupported = !devicesError && devices && devices.capture.length === 0 && devices.playback.length === 0;

  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
    <section className="settings">
      <header><div><span className="eyebrow">OurCord</span><h2>设置与诊断</h2></div><button onClick={close}>×</button></header>
      <div className="settings-grid">
        <label>输入模式
          <select value={prefs.mode} onChange={(e) => setPrefs({ ...prefs, mode: e.target.value as VoiceMode })}>
            <option value="voice_activity">语音激活</option>
            <option value="push_to_talk">按键说话</option>
            <option value="open_mic">开放麦</option>
          </select>
        </label>
        <label>激活阈值 <strong>{prefs.threshold_dbfs} dBFS</strong>
          <input type="range" min="-60" max="-20" value={prefs.threshold_dbfs} onChange={(e) => setPrefs({ ...prefs, threshold_dbfs: Number(e.target.value) })}/>
        </label>
        <button className="primary" onClick={() => void applyVoice()}>应用语音设置</button>

        <div className="settings-block">
          <h3>音频设备</h3>
          {devicesError && <p className="empty">设备列表不可用：{devicesError}</p>}
          {deviceUnsupported && <p className="empty">当前构建不支持设备枚举（需要 voice 构建）。</p>}
          {devices && !deviceUnsupported && <>
            <label>输入设备
              <select value={captureID} onChange={(e) => setCaptureID(e.target.value)}>
                {devices.capture.map((d) => <option key={d.id} value={d.id}>{d.name}{d.is_default ? "（默认）" : ""}</option>)}
              </select>
            </label>
            <label>输出设备
              <select value={playbackID} onChange={(e) => setPlaybackID(e.target.value)}>
                {devices.playback.map((d) => <option key={d.id} value={d.id}>{d.name}{d.is_default ? "（默认）" : ""}</option>)}
              </select>
            </label>
            <button className="secondary" onClick={() => void applyDevices()}>切换设备</button>
          </>}
        </div>

        <div className="settings-block">
          <h3>账号</h3>
          <label>显示名
            <input value={name} maxLength={64} onChange={(e) => setName(e.target.value)} placeholder="别人看到的名字" />
          </label>
          <button className="secondary" disabled={!name.trim() || name.trim() === auth.profile?.user?.display_name} onClick={() => void saveName()}>保存显示名</button>
        </div>

        <div className="diagnostics">
          <h3>网络诊断</h3>
          <dl>
            <div><dt>daemon</dt><dd>{snapshot.daemon_available ? "可用" : "离线"}</dd></div>
            <div><dt>VPN</dt><dd>{snapshot.status?.vpn_active ? "已连接" : "未连接"}</dd></div>
            {snapshot.status?.ip4 && <div><dt>VPN IPv4</dt><dd>{snapshot.status.ip4}</dd></div>}
            <div><dt>路径</dt><dd>{snapshot.status?.path_summary ?? "inactive"}</dd></div>
            {snapshot.status?.relay_url && <div><dt>中继</dt><dd>{snapshot.status.relay_url}</dd></div>}
            <div><dt>路径切换</dt><dd>{snapshot.status?.path_flaps_total ?? 0}</dd></div>
            <div><dt>Peer</dt><dd>{snapshot.peers?.length ?? 0}</dd></div>
          </dl>
          {snapshot.status?.vpn_active && <button className="secondary" onClick={() => void disconnectVPN()}>断开 VPN</button>}
        </div>

        {notice && <p className="notice">{notice}</p>}
        <button className="secondary danger-text" onClick={() => void logout()}>退出账号</button>
      </div>
    </section>
  </div>;
}
