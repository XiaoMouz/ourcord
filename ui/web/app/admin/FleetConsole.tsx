"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatBps, formatRelative, loadPercent, healthBadge, summarizeRelays } from "./format.mjs";

// Operator fleet console. Talks directly to the control Worker's admin-gated
// GET /api/control/fleet (control CORS is Access-Control-Allow-Origin: *, and
// the bearer token is passed in a header, not a cookie, so no credentials mode
// is needed). Auth reuses the existing control OTP login; the resulting user
// must be listed in the control's ADMIN_USER_IDS or the endpoint returns 403.

const CONTROL_URL_KEY = "ourcord.admin.controlUrl";
const TOKEN_KEY = "ourcord.admin.token";
const REFRESH_MS = 15000;

interface RelayRow {
  id: string;
  region: string;
  mode: string;
  hostname: string;
  port: number;
  capacity_kbps: number;
  active_conns: number;
  bytes_per_sec: number;
  last_heartbeat: number;
  healthy: boolean;
}

interface BackendSummary {
  total: number;
  healthy: number;
  unhealthy: number;
  unknown: number;
  unhealthy_backends: { id: string; name: string; base_url: string; last_health_error: string | null }[];
}

interface Fleet {
  environment: string;
  counts: { users: number; active_peers_5m: number; active_relays: number; active_bans: number };
  relays: RelayRow[];
  backends: BackendSummary | null;
  ts: number;
}

function trimUrl(u: string): string {
  return u.trim().replace(/\/+$/, "");
}

export function FleetConsole() {
  const [controlUrl, setControlUrl] = useState("");
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pendingFleet = useRef<AbortController | null>(null);

  const cancelFleet = useCallback(() => {
    const pending = pendingFleet.current;
    pendingFleet.current = null;
    pending?.abort();
  }, []);

  // Restore persisted control URL + session token on mount. We deliberately
  // hydrate in an effect (empty on both server and client first render, then
  // updated) so storage-derived values never cause an SSR hydration mismatch.
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setControlUrl(localStorage.getItem(CONTROL_URL_KEY) ?? "");
      setToken(sessionStorage.getItem(TOKEN_KEY) ?? "");
    } catch {
      /* storage unavailable (SSR / privacy mode) — stay unauthenticated */
    }
  }, []);

  const fetchFleet = useCallback(async () => {
    if (!controlUrl || !token || pendingFleet.current) return;
    const controller = new AbortController();
    pendingFleet.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), REFRESH_MS);
    const isCurrent = () => pendingFleet.current === controller && !controller.signal.aborted;
    setError("");
    try {
      const r = await fetch(`${trimUrl(controlUrl)}/api/control/fleet`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      if (r.status === 401) {
        setError("会话已过期，请重新登录。");
        setFleet(null);
        setToken("");
        try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
        return;
      }
      if (r.status === 403) {
        setError("该账号不在运营者白名单（ADMIN_USER_IDS）中。");
        return;
      }
      if (!r.ok) {
        setError(`control 返回 ${r.status}`);
        return;
      }
      const nextFleet = await r.json();
      // The session can change while the response body is still arriving.
      if (isCurrent()) setFleet(nextFleet);
    } catch (e) {
      if (pendingFleet.current === controller) setError(`无法连接 control：${String(e)}`);
    } finally {
      window.clearTimeout(timeout);
      if (pendingFleet.current === controller) pendingFleet.current = null;
    }
  }, [controlUrl, token]);

  // Timer and manual refresh share one pending request for the current session.
  useEffect(() => {
    if (!token) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchFleet();
    const id = setInterval(fetchFleet, REFRESH_MS);
    return () => { clearInterval(id); cancelFleet(); };
  }, [token, fetchFleet, cancelFleet]);

  async function requestOtp() {
    setBusy(true);
    setError("");
    try {
      const base = trimUrl(controlUrl);
      try { localStorage.setItem(CONTROL_URL_KEY, base); } catch { /* ignore */ }
      const r = await fetch(`${base}/api/auth/otp/request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (!r.ok) {
        setError(`发送验证码失败：${r.status}`);
        return;
      }
      setOtpSent(true);
    } catch (e) {
      setError(`无法连接 control：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`${trimUrl(controlUrl)}/api/auth/otp/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), otp: otp.trim() }),
      });
      if (!r.ok) {
        setError(r.status === 401 ? "验证码无效或已过期。" : `登录失败：${r.status}`);
        return;
      }
      const body = (await r.json()) as { token: string };
      setToken(body.token);
      try { sessionStorage.setItem(TOKEN_KEY, body.token); } catch { /* ignore */ }
      setOtp("");
      setOtpSent(false);
    } catch (e) {
      setError(`无法连接 control：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function signOut() {
    cancelFleet();
    setToken("");
    setFleet(null);
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  }

  if (!token) {
    return (
      <div className="adminCard">
        <h2>运营者登录</h2>
        <label>Control 地址
          <input
            type="url"
            placeholder="https://control.example"
            value={controlUrl}
            onChange={(e) => setControlUrl(e.target.value)}
          />
        </label>
        <label>邮箱
          <input
            type="email"
            placeholder="operator@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        {!otpSent ? (
          <button disabled={busy || !controlUrl || !email} onClick={requestOtp}>发送验证码</button>
        ) : (
          <>
            <label>验证码
              <input
                inputMode="numeric"
                placeholder="6 位验证码"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
              />
            </label>
            <button disabled={busy || otp.length < 6} onClick={verifyOtp}>登录</button>
          </>
        )}
        {error && <p className="adminError">{error}</p>}
      </div>
    );
  }

  const summary = summarizeRelays(fleet?.relays ?? []);

  return (
    <div className="adminDash">
      <div className="adminBar">
        <span>环境：<strong>{fleet?.environment ?? "…"}</strong></span>
        <span>中继：<strong>{summary.up}</strong>/{summary.total} 在线</span>
        <button onClick={fetchFleet}>刷新</button>
        <button onClick={signOut}>退出</button>
      </div>

      {error && <p className="adminError">{error}</p>}

      {fleet && (
        <>
          <div className="adminCounts">
            <Stat label="用户" value={fleet.counts.users} />
            <Stat label="活跃 Peer (5m)" value={fleet.counts.active_peers_5m} />
            <Stat label="在线中继" value={fleet.counts.active_relays} />
            <Stat label="生效封禁" value={fleet.counts.active_bans} />
          </div>

          <h2>中继车队</h2>
          <table className="adminTable">
            <thead>
              <tr>
                <th>状态</th><th>区域</th><th>主机</th><th>模式</th>
                <th>连接</th><th>吞吐</th><th>负载</th><th>心跳</th>
              </tr>
            </thead>
            <tbody>
              {fleet.relays.map((r) => {
                const badge = healthBadge(r.healthy);
                const pct = loadPercent(r.bytes_per_sec, r.capacity_kbps);
                return (
                  <tr key={r.id}>
                    <td><span className={`dot ${badge.cls}`} />{badge.label}</td>
                    <td>{r.region}</td>
                    <td>{r.hostname}:{r.port}</td>
                    <td>{r.mode}</td>
                    <td>{r.active_conns}</td>
                    <td>{formatBps(r.bytes_per_sec)}</td>
                    <td className={pct >= 80 ? "warn" : undefined}>{pct}%</td>
                    <td>{formatRelative(r.last_heartbeat, fleet.ts)}</td>
                  </tr>
                );
              })}
              {fleet.relays.length === 0 && (
                <tr><td colSpan={8} className="adminEmpty">没有注册的中继。</td></tr>
              )}
            </tbody>
          </table>

          <h2>文件后端</h2>
          {fleet.backends ? (
            <>
              <p>
                共 {fleet.backends.total} · 健康 {fleet.backends.healthy} ·
                不健康 <span className={fleet.backends.unhealthy > 0 ? "warn" : undefined}>{fleet.backends.unhealthy}</span> ·
                未知 {fleet.backends.unknown}
              </p>
              {fleet.backends.unhealthy_backends.length > 0 && (
                <ul className="adminBackends">
                  {fleet.backends.unhealthy_backends.map((b) => (
                    <li key={b.id}>{b.name || b.base_url} — {b.last_health_error ?? "unhealthy"}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="adminMuted">服务层未接入（SERVICE_URL 未配置或不可达）。</p>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="adminStat">
      <span className="adminStatValue">{value}</span>
      <span className="adminStatLabel">{label}</span>
    </div>
  );
}
