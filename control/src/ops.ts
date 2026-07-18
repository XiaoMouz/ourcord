// Operator fleet status — read-only aggregate view for the admin console.
//
// Extends the unauthenticated /api/control/status counts into a full,
// admin-gated (ADMIN_USER_IDS) picture of the relay fleet plus a file-backend
// health rollup fetched from the service layer over the internal channel.
//
// It never returns secrets: relay rows carry only public topology/load fields
// (no DERP/WG keys, no owner attribution beyond region/mode), and the backend
// summary is aggregate counts. See docs/ops/monitoring.md for the field dict.

import { Env } from "./types";
import { requireAdmin, json } from "./auth";
import { signInternalHeaders } from "./internalAuth";
import { log } from "./log";

// A relay counts as healthy while it is active and has heartbeated within this
// window. Matches the active-relay window used by /api/control/status so both
// surfaces agree on "up".
const HEARTBEAT_WINDOW_SEC = 120;
// A peer counts as active if seen within this window (mirrors /status).
const PEER_ACTIVE_WINDOW_SEC = 300;

interface RelayRow {
  id: string;
  region: string;
  mode: string;
  hostname: string;
  port: number;
  active: number;
  capacity_kbps: number;
  last_heartbeat: number;
  active_conns: number;
  bytes_per_sec: number;
  reported_at: number;
}

interface BackendHealthSummary {
  total: number;
  healthy: number;
  unhealthy: number;
  unknown: number;
  unhealthy_backends: unknown[];
}

// getFleetStatus handles GET /api/control/fleet. Admin-only.
export async function getFleetStatus(request: Request, env: Env): Promise<Response> {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const now = Math.floor(Date.now() / 1000);

  // Relay fleet: one row per relay_servers entry, left-joined to its coarse
  // load report (relay_load, written by heartbeat). COALESCE so relays that
  // have registered but not yet reported load still appear with zeros.
  const relaysRes = await env.DB.prepare(
    `SELECT s.id, s.region, s.mode, s.hostname, s.port, s.active,
            s.capacity_kbps, s.last_heartbeat,
            COALESCE(l.active_conns, 0) AS active_conns,
            COALESCE(l.bytes_per_sec, 0) AS bytes_per_sec,
            COALESCE(l.reported_at, 0) AS reported_at
       FROM relay_servers s
       LEFT JOIN relay_load l ON l.relay_id = s.id
      ORDER BY s.region ASC, s.hostname ASC`,
  ).all<RelayRow>();

  const relays = (relaysRes.results ?? []).map((r) => ({
    id: r.id,
    region: r.region,
    mode: r.mode,
    hostname: r.hostname,
    port: r.port,
    capacity_kbps: r.capacity_kbps,
    active_conns: r.active_conns,
    bytes_per_sec: r.bytes_per_sec,
    last_heartbeat: r.last_heartbeat,
    reported_at: r.reported_at,
    healthy: r.active === 1 && r.last_heartbeat > now - HEARTBEAT_WINDOW_SEC,
  }));

  const [users, activePeers, activeRelays, activeBans] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS c FROM users").first<{ c: number }>(),
    env.DB
      .prepare("SELECT COUNT(*) AS c FROM peers WHERE last_seen > ?")
      .bind(now - PEER_ACTIVE_WINDOW_SEC)
      .first<{ c: number }>(),
    env.DB
      .prepare("SELECT COUNT(*) AS c FROM relay_servers WHERE active = 1 AND last_heartbeat > ?")
      .bind(now - HEARTBEAT_WINDOW_SEC)
      .first<{ c: number }>(),
    env.DB
      .prepare("SELECT COUNT(*) AS c FROM bans WHERE expires_at IS NULL OR expires_at > ?")
      .bind(now)
      .first<{ c: number }>(),
  ]);

  const backends = await fetchBackendHealthSummary(env);

  return json({
    status: "ok",
    environment: env.ENVIRONMENT ?? "unknown",
    counts: {
      users: users?.c ?? 0,
      active_peers_5m: activePeers?.c ?? 0,
      active_relays: activeRelays?.c ?? 0,
      active_bans: activeBans?.c ?? 0,
    },
    relays,
    backends,
    ts: Date.now(),
  });
}

// fetchBackendHealthSummary pulls the file-backend rollup from the service layer
// over the signed internal channel. Best-effort: if the service isn't wired or
// is unreachable, the fleet view still renders with backends: null so a service
// blip never takes down the operator dashboard.
async function fetchBackendHealthSummary(env: Env): Promise<BackendHealthSummary | null> {
  if (!env.SERVICE_URL || !env.SERVICE_INTERNAL_TOKEN) return null;
  const url = `${env.SERVICE_URL}/api/internal/backends/health-summary`;
  try {
    const r = await fetch(url, {
      headers: await signInternalHeaders(env.SERVICE_INTERNAL_TOKEN, "GET", url),
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) {
      log({ event: "ops.backend_summary_failed", level: "warn", status: r.status });
      return null;
    }
    return await r.json<BackendHealthSummary>();
  } catch (e) {
    log({ event: "ops.backend_summary_error", level: "warn", error: String(e) });
    return null;
  }
}
