// Operator file-backend health rollup.
//
// The service layer owns the file_backends registry and already records each
// backend's health (health_status / last_health_at / last_health_error, written
// by backends.ts probes). This module aggregates that into a fleet summary the
// control-plane operator view (control/src/ops.ts) merges into /api/control/fleet.
//
// It is exposed only over the internal control→service channel (signed
// short-lived HMAC headers, verified in index.ts via verifyInternalRequest);
// there is no user-facing auth here and it never returns upload_secret.

import { Env } from "./types";

export interface UnhealthyBackend {
  id: string;
  name: string;
  base_url: string;
  last_health_at: number | null;
  last_health_error: string | null;
}

export interface BackendHealthSummary {
  total: number;
  healthy: number;
  unhealthy: number;
  unknown: number;
  unhealthy_backends: UnhealthyBackend[];
}

// getBackendHealthSummary rolls up active file_backends by health_status.
// `unknown` covers rows never probed (NULL) or any non-healthy/unhealthy value,
// so total always equals healthy + unhealthy + unknown.
export async function getBackendHealthSummary(env: Env): Promise<BackendHealthSummary> {
  const grouped = await env.DB.prepare(
    `SELECT health_status AS status, COUNT(*) AS c
       FROM file_backends
      WHERE active = 1
      GROUP BY health_status`,
  ).all<{ status: string | null; c: number }>();

  let total = 0;
  let healthy = 0;
  let unhealthy = 0;
  let unknown = 0;
  for (const row of grouped.results ?? []) {
    total += row.c;
    if (row.status === "healthy") healthy += row.c;
    else if (row.status === "unhealthy") unhealthy += row.c;
    else unknown += row.c;
  }

  // Bounded detail list so the operator can see which backends are failing
  // without paging the whole registry. Never selects upload_secret.
  const bad = await env.DB.prepare(
    `SELECT id, name, base_url, last_health_at, last_health_error
       FROM file_backends
      WHERE active = 1 AND health_status = 'unhealthy'
      ORDER BY last_health_at DESC
      LIMIT 20`,
  ).all<UnhealthyBackend>();

  return { total, healthy, unhealthy, unknown, unhealthy_backends: bad.results ?? [] };
}
