import { useEffect, useState } from "react";
import { bridge, type Device, type LocalProfile, type Snapshot } from "../bridge";
import { pathLabel } from "../quality";
import { relativeTime, shortKey } from "../format";
import { Spinner } from "./Skeleton";
import { useDialog } from "../dialog";
import { ModalHeader, Tooltip, cx } from "./ui";

// Diagnostics + device management (mirrors the TUI's peer-detail view and the
// CLI diagnostics/devices commands, which the desktop client lacked). Reachable
// from settings.
export default function DiagnosticsModal({ snapshot, close, onError }: {
  snapshot: Snapshot;
  close: () => void;
  onError: (message: string) => void;
}) {
  const dialog = useDialog();
  const [profile, setProfile] = useState<LocalProfile>();
  const [profileError, setProfileError] = useState("");
  const [profileAttempt, setProfileAttempt] = useState(0);
  const [devices, setDevices] = useState<Device[]>();
  const [devicesError, setDevicesError] = useState("");
  const [ping, setPing] = useState<string>("");
  const [pinging, setPinging] = useState(false);
  const [forcing, setForcing] = useState("");

  useEffect(() => {
    let cancelled = false;
    setProfile(undefined);
    setProfileError("");
    void (async () => {
      try {
        const data = await bridge<{ profile: LocalProfile }>("daemon.profile");
        if (!data.profile?.public_key?.trim()) throw new Error("Local device key unavailable");
        if (!cancelled) setProfile(data.profile);
      } catch {
        if (!cancelled) setProfileError("无法确认本机设备，暂不能吊销设备。请重试。");
      }
    })();
    return () => { cancelled = true; };
  }, [profileAttempt]);

  useEffect(() => {
    void refreshDevices();
  }, []);

  async function refreshDevices() {
    try { const data = await bridge<{ devices: Device[] }>("devices.list"); setDevices(data.devices ?? []); }
    catch (e) { setDevicesError(String(e)); setDevices([]); }
  }

  async function runPing() {
    setPinging(true);
    try {
      const data = await bridge<{ rtt_ms: number }>("diagnostics.ping");
      setPing(data.rtt_ms < 1 ? "<1ms" : `${data.rtt_ms}ms`);
    }
    catch (e) { setPing(""); onError(String(e)); } finally { setPinging(false); }
  }

  async function forceDERP(publicKey: string) {
    setForcing(publicKey);
    try { await bridge("diagnostics.force_derp", { public_key: publicKey, reason: "desktop-diagnostic" }); }
    catch (e) { onError(String(e)); } finally { setForcing(""); }
  }

  async function revoke(device: Device) {
    // The account's remote device list can arrive before the local identity.
    if (!profile?.public_key) { onError("无法确认本机设备，暂不能吊销设备。请重试。"); return; }
    if (device.public_key === profile?.public_key) { onError("不能吊销当前设备"); return; }
    const ok = await dialog.confirm({ title: `吊销设备「${device.name || device.id}」`, message: "该设备将需要重新登录。", confirmLabel: "吊销", danger: true });
    if (!ok) return;
    try { await bridge("devices.revoke", { id: device.id }); await refreshDevices(); }
    catch (e) { onError(String(e)); }
  }

  const peers = snapshot.peers ?? [];
  const t = snapshot.status?.transport;

  return <div className="modal modal-open" onMouseDown={(e) => e.target === e.currentTarget && close()}>
    <section className="modal-box max-h-[90vh] max-w-4xl overflow-hidden p-0">
      <ModalHeader title="连接诊断" onClose={close} />
      <div className="space-y-4 overflow-y-auto p-6" style={{ maxHeight: "calc(90vh - 5rem)" }}>
        <div className="stats stats-vertical w-full bg-base-200 shadow-sm sm:stats-horizontal">
          <div className="stat px-4 py-3"><div className="stat-title text-xs">后台服务</div><div className="stat-value text-base">{snapshot.daemon_available ? "在线" : "离线"}</div></div>
          <div className="stat px-4 py-3"><div className="stat-title text-xs">VPN</div><div className="stat-value text-base">{snapshot.status?.vpn_active ? pathLabel(snapshot.status.path_summary) : "未连接"}</div><div className="stat-desc font-mono">{snapshot.status?.ip4 ?? "—"}</div></div>
          <div className="stat px-4 py-3"><div className="stat-title text-xs">路径切换</div><div className="stat-value text-base">{snapshot.status?.path_flaps_total ?? 0}</div></div>
          <div className="stat px-4 py-3"><div className="stat-title text-xs">本机设备</div><div className="stat-value text-base">{profile ? (profile.enrolled ? "已注册" : "未注册") : "…"}</div><div className="stat-desc font-mono">{profile ? shortKey(profile.public_key) : "—"}</div></div>
        </div>
        <div className="flex justify-end"><Tooltip label="检测桌面应用与本机后台服务的连接，不代表 Peer 网络延迟">
          <button className="btn btn-sm" disabled={pinging} onClick={() => void runPing()}>{pinging && <Spinner />}后台响应{ping && ` · ${ping}`}</button>
        </Tooltip></div>

        <section className="card card-border bg-base-200"><div className="card-body gap-3 p-5">
          <h3 className="card-title text-base">Peer <span className="badge badge-ghost badge-sm">{peers.length}</span></h3>
          {peers.length === 0 && <div className="py-4 text-sm text-base-content/45">暂无已连接 Peer</div>}
          <ul className="list rounded-box bg-base-100">
          {peers.map((peer) => <li key={peer.public_key} className="list-row items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <strong className="truncate">{peer.display_name || shortKey(peer.public_key)}</strong>
                <span className={cx("badge badge-sm", peer.path === "direct" ? "badge-success badge-soft" : peer.path === "derp" || peer.path === "next-hop" ? "badge-warning badge-soft" : "badge-ghost")}>{peer.path}</span>
                {peer.flapping && <Tooltip label="路径抖动"><span className="badge badge-warning badge-soft badge-sm">⚠</span></Tooltip>}
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-base-content/50">
                {peer.ip4 && <span className="font-mono">{peer.ip4}</span>}
                {peer.latency_ms > 0 && <span>{Math.round(peer.latency_ms)}ms</span>}
                {typeof peer.path_transitions === "number" && <span>切换 {peer.path_transitions}</span>}
                {peer.endpoint && <Tooltip label="ICE endpoint"><span className="max-w-52 truncate font-mono">{peer.endpoint}</span></Tooltip>}
                {peer.next_hop && <Tooltip label="下一跳"><span className="font-mono">→ {shortKey(peer.next_hop)}</span></Tooltip>}
                {peer.last_error && <Tooltip label={peer.last_error}><span className="text-error">错误</span></Tooltip>}
              </div>
            </div>
            <Tooltip label="强制走中继（诊断）"><button className="btn btn-ghost btn-sm" disabled={forcing === peer.public_key || peer.path === "derp"}
              onClick={() => void forceDERP(peer.public_key)}>
              {forcing === peer.public_key ? <Spinner/> : "强制中继"}
            </button></Tooltip>
          </li>)}
          </ul>
        </div></section>

        {t && <section className="card card-border bg-base-200"><div className="card-body gap-3 p-5">
          <h3 className="card-title text-base">传输统计</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {[`MTU ${t.mtu ?? "—"}`, `ICE ↑${t.ice_sent_packets ?? 0} ↓${t.ice_recv_packets ?? 0}`, `ICE 丢弃 ${t.ice_recv_drops ?? 0}`,
              `DERP ↑${t.derp_sent_packets ?? 0} ↓${t.derp_recv_packets ?? 0}`, `DERP 丢弃 ${t.derp_recv_drops ?? 0}`, `ICE 错误 ${(t.ice_send_errors ?? 0) + (t.ice_recv_errors ?? 0)}`]
              .map((value) => <div key={value} className="rounded-field bg-base-100 px-3 py-2 font-mono text-xs">{value}</div>)}
          </div>
        </div></section>}

        <section className="card card-border bg-base-200"><div className="card-body gap-3 p-5">
          <h3 className="card-title text-base">已注册设备</h3>
          {!profile && !profileError && <Spinner label="正在确认本机设备…" />}
          {profileError && <div role="alert" className="alert alert-warning">
            <span>{profileError}</span>
            <button className="btn btn-sm" onClick={() => setProfileAttempt((attempt) => attempt + 1)}>重试本机识别</button>
          </div>}
          {!devices && !devicesError && <Spinner label="载入设备…" />}
          {devicesError && <div role="alert" className="alert alert-error"><span>{devicesError}</span></div>}
          <ul className="list rounded-box bg-base-100">
          {devices?.filter((d) => !d.revoked_at).map((device) => <li key={device.id} className="list-row items-center">
            <div className="min-w-0 flex-1">
              <strong className="flex items-center gap-2 truncate">{device.name || shortKey(device.public_key)}
                {device.public_key === profile?.public_key && <span className="badge badge-primary badge-soft badge-xs">本机</span>}
              </strong>
              <small className="block truncate font-mono text-base-content/45">{shortKey(device.public_key)} · {relativeTime(device.last_used)}</small>
            </div>
            <button className="btn btn-error btn-soft btn-sm" disabled={!profile?.public_key || device.public_key === profile.public_key} onClick={() => void revoke(device)}>吊销</button>
          </li>)}
          </ul>
          {devices && devices.filter((d) => !d.revoked_at).length === 0 && <div className="py-4 text-sm text-base-content/45">暂无设备</div>}
        </div></section>
      </div>
    </section>
  </div>;
}
