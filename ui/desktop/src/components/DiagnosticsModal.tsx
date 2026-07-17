import { useEffect, useState } from "react";
import { bridge, type Device, type LocalProfile, type Snapshot } from "../bridge";
import { pathLabel } from "../quality";
import { pathTone, relativeTime, shortKey } from "../format";
import { Spinner } from "./Skeleton";

// Diagnostics + device management (mirrors the TUI's peer-detail view and the
// CLI diagnostics/devices commands, which the desktop client lacked). Reachable
// from settings.
export default function DiagnosticsModal({ snapshot, close, onError }: {
  snapshot: Snapshot;
  close: () => void;
  onError: (message: string) => void;
}) {
  const [profile, setProfile] = useState<LocalProfile>();
  const [devices, setDevices] = useState<Device[]>();
  const [devicesError, setDevicesError] = useState("");
  const [ping, setPing] = useState<string>("");
  const [pinging, setPinging] = useState(false);
  const [forcing, setForcing] = useState("");

  useEffect(() => {
    void (async () => {
      try { const data = await bridge<{ profile: LocalProfile }>("daemon.profile"); setProfile(data.profile); } catch { /* daemon offline */ }
    })();
    void refreshDevices();
  }, []);

  async function refreshDevices() {
    try { const data = await bridge<{ devices: Device[] }>("devices.list"); setDevices(data.devices ?? []); }
    catch (e) { setDevicesError(String(e)); setDevices([]); }
  }

  async function runPing() {
    setPinging(true);
    try { const data = await bridge<{ rtt_ms: number }>("diagnostics.ping"); setPing(`${data.rtt_ms}ms`); }
    catch (e) { setPing(""); onError(String(e)); } finally { setPinging(false); }
  }

  async function forceDERP(publicKey: string) {
    setForcing(publicKey);
    try { await bridge("diagnostics.force_derp", { public_key: publicKey, reason: "desktop-diagnostic" }); }
    catch (e) { onError(String(e)); } finally { setForcing(""); }
  }

  async function revoke(device: Device) {
    if (device.public_key === profile?.public_key) { onError("不能吊销当前设备"); return; }
    if (!confirm(`吊销设备「${device.name || device.id}」？该设备将需要重新登录。`)) return;
    try { await bridge("devices.revoke", { id: device.id }); await refreshDevices(); }
    catch (e) { onError(String(e)); }
  }

  const peers = snapshot.peers ?? [];
  const t = snapshot.status?.transport;

  return <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
    <section className="settings diagnostics-modal">
      <header><div><span className="eyebrow">OurCord</span><h2>连接诊断</h2></div><button onClick={close}>×</button></header>
      <div className="settings-grid">
        <div className="diag-status">
          <div><dt>daemon</dt><dd>{snapshot.daemon_available ? "在线" : "离线"}</dd></div>
          <div><dt>VPN</dt><dd>{snapshot.status?.vpn_active ? `${snapshot.status.ip4 ?? ""} / ${pathLabel(snapshot.status.path_summary)}` : "未连接"}</dd></div>
          <div><dt>路径抖动累计</dt><dd>{snapshot.status?.path_flaps_total ?? 0}</dd></div>
          <div><dt>本机设备</dt><dd>{profile ? (profile.enrolled ? `已注册 · ${shortKey(profile.public_key)}` : "未注册") : "…"}</dd></div>
          <div><dt>daemon 往返</dt><dd className="ping-cell">{ping || "—"}<button disabled={pinging} onClick={() => void runPing()}>{pinging ? <Spinner/> : "Ping"}</button></dd></div>
        </div>

        <div className="settings-block">
          <h3>Peer · {peers.length}</h3>
          {peers.length === 0 && <p className="empty">没有已连接的 peer</p>}
          {peers.map((peer) => <div key={peer.public_key} className="peer-row">
            <div className="peer-main">
              <strong>{peer.display_name || peer.name || shortKey(peer.public_key)}</strong>
              <span className={`peer-path ${pathTone(peer.path)}`}>{peer.path}</span>
              {peer.flapping && <span className="flap-badge" title="路径抖动">⚠</span>}
            </div>
            <div className="peer-meta">
              {peer.ip4 && <span>{peer.ip4}</span>}
              {peer.latency_ms > 0 && <span>{Math.round(peer.latency_ms)}ms</span>}
              {typeof peer.path_transitions === "number" && <span>切换 {peer.path_transitions}</span>}
              {peer.endpoint && <span title="ICE endpoint">{peer.endpoint}</span>}
              {peer.next_hop && <span title="下一跳">→ {shortKey(peer.next_hop)}</span>}
              {peer.last_error && <span className="peer-error" title={peer.last_error}>err</span>}
            </div>
            <button className="peer-derp" disabled={forcing === peer.public_key || peer.path === "derp"}
              title="强制走中继（诊断）" onClick={() => void forceDERP(peer.public_key)}>
              {forcing === peer.public_key ? <Spinner/> : "强制中继"}
            </button>
          </div>)}
        </div>

        {t && <div className="settings-block">
          <h3>传输统计</h3>
          <div className="diag-counters">
            <span>MTU {t.mtu ?? "—"}</span>
            <span>ICE ↑{t.ice_sent_packets ?? 0} ↓{t.ice_recv_packets ?? 0}</span>
            <span>ICE 丢弃 {t.ice_recv_drops ?? 0}</span>
            <span>DERP ↑{t.derp_sent_packets ?? 0} ↓{t.derp_recv_packets ?? 0}</span>
            <span>DERP 丢弃 {t.derp_recv_drops ?? 0}</span>
            <span>ICE 错误 {(t.ice_send_errors ?? 0) + (t.ice_recv_errors ?? 0)}</span>
          </div>
        </div>}

        <div className="settings-block">
          <h3>已注册设备</h3>
          {!devices && !devicesError && <Spinner label="载入设备…" />}
          {devicesError && <p className="empty">无法载入设备：{devicesError}</p>}
          {devices?.filter((d) => !d.revoked_at).map((device) => <div key={device.id} className="device-row">
            <div>
              <strong>{device.name || shortKey(device.public_key)}
                {device.public_key === profile?.public_key && <span className="this-device">本机</span>}
              </strong>
              <small>{shortKey(device.public_key)} · 最近使用 {relativeTime(device.last_used)}</small>
            </div>
            <button disabled={device.public_key === profile?.public_key} onClick={() => void revoke(device)}>吊销</button>
          </div>)}
          {devices && devices.filter((d) => !d.revoked_at).length === 0 && <p className="empty">没有已注册设备</p>}
        </div>
      </div>
    </section>
  </div>;
}
