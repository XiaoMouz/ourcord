import { useEffect, useState } from "react";
import { bridge, type AudioDevice, type AuthState, type Snapshot } from "../bridge";
import { loadVoicePrefs, saveVoicePrefs, type VoiceMode } from "../prefs";
import { ModalFrame, ModalHeader } from "./ui";

type DeviceLists = { capture: AudioDevice[]; playback: AudioDevice[] };
// Keep in sync with control/src/profile.ts (JavaScript string length).
const DISPLAY_NAME_MAX = 48;

export default function SettingsModal({ snapshot, auth, close, refreshSnapshot, refreshAuth, logout, onError, onNotice, openDiagnostics }: {
  snapshot: Snapshot;
  auth: AuthState;
  close: () => void;
  refreshSnapshot: () => Promise<void>;
  refreshAuth: () => Promise<void>;
  logout: () => Promise<void>;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  openDiagnostics: () => void;
}) {
  const [section, setSection] = useState<"语音" | "账号" | "网络">("语音");
  const [prefs, setPrefs] = useState(() => loadVoicePrefs());
  const [devices, setDevices] = useState<DeviceLists>();
  const [devicesError, setDevicesError] = useState("");
  const [captureID, setCaptureID] = useState("");
  const [playbackID, setPlaybackID] = useState("");
  const [name, setName] = useState(auth.profile?.user?.display_name ?? "");
  const trimmedName = name.trim();
  const nameTooLong = trimmedName.length > DISPLAY_NAME_MAX;

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
      onNotice("语音设置已应用");
    } catch (e) { onError(String(e)); }
  }

  async function applyDevices() {
    try {
      await bridge("voice.set_devices", { capture_id: captureID, playback_id: playbackID });
      onNotice("音频设备已切换");
    } catch (e) { onError(String(e)); }
  }

  async function saveName() {
    if (!trimmedName || nameTooLong) return;
    try {
      await bridge("profile.update", { display_name: trimmedName });
      await refreshAuth();
      onNotice("显示名已更新");
    } catch (e) { onError(String(e)); }
  }

  async function disconnectVPN() {
    try {
      await bridge("network.disconnect");
      await refreshSnapshot();
      onNotice("VPN 已断开");
    } catch (e) { onError(String(e)); }
  }

  const deviceUnsupported = !devicesError && devices && devices.capture.length === 0 && devices.playback.length === 0;

  return <ModalFrame label="设置" className="settings-box" onClose={close}>
      <ModalHeader title="设置" onClose={close} />
      <div className="settings-layout">
        <nav aria-label="设置分类">{(["语音", "账号", "网络"] as const).map((item) =>
          <button key={item} type="button" aria-current={section === item ? "true" : undefined} onClick={() => setSection(item)}>{item}</button>)}
        </nav>
        <div className="settings-content" key={section}>
          {section === "语音" && <><section className="settings-group">
            <h3>语音</h3>
          <fieldset className="fieldset">
            <legend className="fieldset-legend">输入模式</legend>
            <select className="select w-full" aria-label="输入模式" value={prefs.mode} onChange={(e) => setPrefs({ ...prefs, mode: e.target.value as VoiceMode })}>
              <option value="voice_activity">语音激活</option>
              <option value="push_to_talk">按键说话</option>
              <option value="open_mic">开放麦</option>
            </select>
          </fieldset>
          <fieldset className="fieldset">
            <legend className="fieldset-legend flex justify-between"><span>激活阈值</span><span>{prefs.threshold_dbfs} dBFS</span></legend>
            <input className="range range-primary range-sm" aria-label="激活阈值" disabled={prefs.mode !== "voice_activity"} type="range" min="-60" max="-20" value={prefs.threshold_dbfs} onChange={(e) => setPrefs({ ...prefs, threshold_dbfs: Number(e.target.value) })}/>
          </fieldset>
          <div className="card-actions justify-end"><button className="btn btn-primary btn-sm" onClick={() => void applyVoice()}>应用</button></div>
          </section>

          <section className="settings-group">
            <h3>音频设备</h3>
            {devicesError && <div role="alert" className="alert alert-error"><span>{devicesError}</span></div>}
            {deviceUnsupported && <div role="alert" className="alert alert-warning"><span>未检测到可用的音频设备。</span></div>}
            {devices && !deviceUnsupported && <>
              <fieldset className="fieldset"><legend className="fieldset-legend">输入设备</legend>
                <select className="select w-full" aria-label="输入设备" value={captureID} onChange={(e) => setCaptureID(e.target.value)}>
                  {devices.capture.map((d) => <option key={d.id} value={d.id}>{d.name}{d.is_default ? "（默认）" : ""}</option>)}
                </select>
              </fieldset>
              <fieldset className="fieldset"><legend className="fieldset-legend">输出设备</legend>
                <select className="select w-full" aria-label="输出设备" value={playbackID} onChange={(e) => setPlaybackID(e.target.value)}>
                  {devices.playback.map((d) => <option key={d.id} value={d.id}>{d.name}{d.is_default ? "（默认）" : ""}</option>)}
                </select>
              </fieldset>
              <div className="card-actions justify-end"><button className="btn btn-sm" onClick={() => void applyDevices()}>切换设备</button></div>
            </>}
          </section></>}

          {section === "账号" && <section className="settings-group">
            <h3>账号</h3>
            <fieldset className="fieldset"><legend className="fieldset-legend">显示名</legend>
              <input className="input w-full" aria-label="显示名" value={name} maxLength={DISPLAY_NAME_MAX} aria-invalid={nameTooLong || undefined} aria-describedby={nameTooLong ? "display-name-error" : undefined} onChange={(e) => setName(e.target.value)} />
              {nameTooLong && <p id="display-name-error" role="alert" className="text-error">显示名过长，请缩短后保存。</p>}
            </fieldset>
            <div className="card-actions justify-end"><button className="btn btn-sm" disabled={!trimmedName || nameTooLong || trimmedName === auth.profile?.user?.display_name} onClick={() => void saveName()}>保存</button></div>
            <div className="settings-signout"><button className="btn btn-error btn-soft btn-sm" onClick={() => void logout()}>退出账号</button></div>
          </section>}

          {section === "网络" && <section className="settings-group">
            <h3>网络</h3>
            {!snapshot.daemon_available && <div role="alert" className="alert alert-warning"><span>后台服务不可用，正在重试。</span></div>}
            <div className="stats stats-vertical bg-base-100 shadow-sm sm:stats-horizontal">
              <div className="stat px-4 py-3"><div className="stat-title text-xs">后台服务</div><div className="stat-value text-base">{snapshot.daemon_available ? "在线" : "离线"}</div></div>
              <div className="stat px-4 py-3"><div className="stat-title text-xs">VPN</div><div className="stat-value text-base">{snapshot.status?.vpn_active ? "已连接" : "未连接"}</div></div>
              <div className="stat px-4 py-3"><div className="stat-title text-xs">Peer</div><div className="stat-value text-base">{snapshot.peers?.length ?? 0}</div></div>
            </div>
            {snapshot.status?.ip4 && <div className="badge badge-ghost font-mono">{snapshot.status.ip4}</div>}
            <div className="card-actions justify-end">
              <button className="btn btn-sm" onClick={openDiagnostics}>连接诊断</button>
              {snapshot.status?.vpn_active && <button className="btn btn-sm" onClick={() => void disconnectVPN()}>断开 VPN</button>}
            </div>
          </section>}
        </div>
      </div>
  </ModalFrame>;
}
