// Autonomous file backends (Phase 2, AGENTS.md 3.5).
//
// The storage priority chain is fixed by the product spec: 用户自建服务器 →
// 别人分享给用户的服务器 → 大厅服务器 → R2 fallback. Until now the first three
// tiers were only policy switches with an `external:` placeholder — no actual
// backend registry existed, so every real upload landed in R2. This module
// adds the registry (file_backends + file_backend_shares), management
// endpoints, and the resolver that walks the chain for a concrete backend.
//
// A "backend" is an HTTP file server the user (or lobby operator) runs
// themselves; the service layer only stores its base_url and hands out
// upload/download URLs under it. Metadata always stays in D1 (spec). The
// upload/download contract with the backend is `{base_url}/{storage_key}`
// where storage_key is `files/<fileId>/<filename>` — the reference backend
// server implementation is a Phase-2 follow-up.

import { Env, FileBackend, FilePolicy } from "./types";
import { requireAuth, generateId, json, err, checkBodySize, hmacSign } from "./auth";
import { log } from "./log";

// Validate a user-supplied backend base URL before storing or ever returning
// it to other members: http(s) only, parseable, no embedded credentials, no
// query/fragment, bounded length.
export function validBackendURL(raw: string): boolean {
  if (typeof raw !== "string" || raw.length < 8 || raw.length > 255) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (u.username || u.password || u.search || u.hash) return false;
  return true;
}

// joinBackendURL builds the concrete file URL under a backend without double
// slashes; storage_key never starts with "/" (see files.ts). Each path segment
// is percent-encoded so filenames with spaces/#/? survive as a URL; the
// capability signature is over the RAW storage_key, which the backend
// recovers from its already-decoded request path.
export function joinBackendURL(baseURL: string, storageKey: string): string {
  const encoded = storageKey.split("/").map(encodeURIComponent).join("/");
  return `${baseURL.replace(/\/+$/, "")}/${encoded}`;
}

// Capability contract with the reference backend (see AGENTS.md 3.5 and
// filebackend/cmd/ourcord-filebackend):
//
//   cap = <exp> "." base64url(HMAC-SHA256(upload_secret, storage_key "\n" op "\n" <exp>))
//
// op is "put" (upload) or "get" (GET/HEAD download + verification). A backend
// registered without a secret is an open backend: no cap is appended and the
// server enforces nothing (dev mode).
export async function signBackendCapability(
  secret: string,
  storageKey: string,
  op: "put" | "get",
  ttlSec: number,
): Promise<string> {
  if (secret === "") return "";
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = await hmacSign(secret, `${storageKey}\n${op}\n${exp}`);
  return `${exp}.${sig}`;
}

// backendFileURL is the one place upload/download/verification URLs are built:
// {base_url}/{storage_key}, plus ?cap= when the backend has a secret.
export async function backendFileURL(
  backend: Pick<FileBackend, "base_url" | "upload_secret">,
  storageKey: string,
  op: "put" | "get",
  ttlSec: number,
): Promise<string> {
  const url = joinBackendURL(backend.base_url, storageKey);
  const cap = await signBackendCapability(backend.upload_secret ?? "", storageKey, op, ttlSec);
  return cap === "" ? url : `${url}?cap=${encodeURIComponent(cap)}`;
}

const UNHEALTHY_SKIP_WINDOW_SEC = 3600;
const BACKEND_HEALTH_PATH = "/.well-known/ourcord-file-backend/health";

function liveBackendWhere(now: number): string {
  const cutoff = now - UNHEALTHY_SKIP_WINDOW_SEC;
  return `(health_status IS NULL OR health_status != 'unhealthy' OR last_health_at IS NULL OR last_health_at < ${cutoff})`;
}

export function backendHealthURL(baseURL: string): string {
  return joinBackendURL(baseURL, BACKEND_HEALTH_PATH.replace(/^\/+/, ""));
}

// resolveFileBackend walks 自建 → 分享 → 大厅 → R2 and returns the first
// usable tier. The product contract is a fixed priority chain; the legacy
// upload preference field is accepted by files.ts for wire compatibility but
// must not reorder this chain.
export async function resolveFileBackend(
  env: Env,
  uploaderId: string,
  lobbyId: string,
  policy: FilePolicy,
  _preference?: "user_server" | "lobby_server" | "r2",
): Promise<{ location: "user_server" | "lobby_server" | "r2"; backend: FileBackend | null } | null> {
  const now = Math.floor(Date.now() / 1000);
  // b.-qualified health filter so every branch shares one aliased table.
  const healthyB = liveBackendWhere(now)
    .replaceAll("health_status", "b.health_status")
    .replaceAll("last_health_at", "b.last_health_at");

  // The 自建 → 分享 → 大厅 chain is a single ordered query instead of up to
  // three sequential round-trips: each enabled tier is a UNION ALL branch tagged
  // with a priority (own=1, shared=2, lobby=3), and we take the lowest priority,
  // newest row. r2 stays a terminal fallback with no backend row.
  // Anchor each tier to its caller scope. Without these access paths, D1
  // can start at lobby_id IS NULL / active and scan unrelated registrations.
  // CROSS JOIN keeps shares first, followed by primary-key backend lookups.
  const branches: string[] = [];
  const binds: unknown[] = [];
  if (policy.user_server_enabled === 1) {
    branches.push(
      `SELECT b.*, 1 AS __prio, b.created_at AS __sort
       FROM file_backends b INDEXED BY idx_file_backends_owner
       WHERE b.owner_id = ? AND b.lobby_id IS NULL AND b.active = 1 AND ${healthyB}`,
    );
    binds.push(uploaderId);
    branches.push(
      `SELECT b.*, 2 AS __prio, s.created_at AS __sort
       FROM file_backend_shares s INDEXED BY idx_backend_shares_grantee
       CROSS JOIN file_backends b ON b.id = s.backend_id
       WHERE s.grantee_id = ? AND b.lobby_id IS NULL AND b.active = 1 AND ${healthyB}`,
    );
    binds.push(uploaderId);
  }
  if (policy.lobby_server_enabled === 1) {
    branches.push(
      `SELECT b.*, 3 AS __prio, b.created_at AS __sort
       FROM file_backends b INDEXED BY idx_file_backends_lobby
       WHERE b.lobby_id = ? AND b.active = 1 AND ${healthyB}`,
    );
    binds.push(lobbyId);
  }

  if (branches.length > 0) {
    const sql = `${branches.join("\nUNION ALL\n")}\nORDER BY __prio ASC, __sort DESC LIMIT 1`;
    const row = await env.DB.prepare(sql).bind(...binds).first<FileBackend & { __prio?: number; __sort?: number }>();
    if (row) {
      const { __prio, __sort, ...backend } = row;
      void __prio;
      void __sort;
      // own/shared personal backends have lobby_id IS NULL; a lobby backend
      // carries its lobby_id. That distinction is the location, so no synthetic
      // column is needed.
      const location = (backend as FileBackend).lobby_id ? "lobby_server" : "user_server";
      return { location, backend: backend as FileBackend };
    }
  }
  if (policy.r2_enabled === 1) {
    return { location: "r2", backend: null };
  }
  return null;
}

export async function probeBackendHealth(baseURL: string): Promise<{ status: "healthy" | "unhealthy"; error: string | null }> {
  try {
    const resp = await fetch(backendHealthURL(baseURL), { method: "GET", signal: AbortSignal.timeout(5000) });
    // Only status is needed. Release the connection even if the backend sends
    // an endless body; otherwise later probes can exhaust fetch connections.
    await resp.body?.cancel();
    if (resp.ok) return { status: "healthy", error: null };
    return { status: "unhealthy", error: `health returned ${resp.status}` };
  } catch (e) {
    return { status: "unhealthy", error: String(e).slice(0, 255) };
  }
}

async function writeBackendHealth(
  env: Env,
  backendId: string,
  status: "healthy" | "unhealthy",
  errorMsg: string | null,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  await env.DB
    .prepare("UPDATE file_backends SET health_status = ?, last_health_at = ?, last_health_error = ? WHERE id = ?")
    .bind(status, now, errorMsg, backendId)
    .run();
}

export async function checkBackendHealth(request: Request, env: Env, backendId: string): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const backend = await env.DB
    .prepare("SELECT * FROM file_backends WHERE id = ? AND active = 1")
    .bind(backendId)
    .first<FileBackend>();
  if (!backend) return err("backend not found", 404);

  if (backend.lobby_id) {
    const member = await env.DB
      .prepare("SELECT role FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
      .bind(backend.lobby_id, auth.sub)
      .first<{ role: string }>();
    if (!member || (member.role !== "owner" && member.role !== "admin")) {
      return err("only lobby owner/admin can check this backend", 403);
    }
  } else if (backend.owner_id !== auth.sub) {
    return err("only the owner can check this backend", 403);
  }

  const result = await probeBackendHealth(backend.base_url);
  const now = Math.floor(Date.now() / 1000);
  await writeBackendHealth(env, backend.id, result.status, result.error, now);
  return json({
    backend_id: backend.id,
    health_status: result.status,
    checked_at: now,
    error: result.error,
  });
}

export async function runBackendHealthChecks(env: Env, batchSize = 50): Promise<{ checked: number; healthy: number; unhealthy: number }> {
  const rows = await env.DB
    .prepare(
      `SELECT * FROM file_backends
       WHERE active = 1
       ORDER BY COALESCE(last_health_at, 0) ASC
       LIMIT ?`,
    )
    .bind(batchSize)
    .all<FileBackend>();

  let checked = 0;
  let healthy = 0;
  let unhealthy = 0;
  for (const backend of rows.results ?? []) {
    const result = await probeBackendHealth(backend.base_url);
    await writeBackendHealth(env, backend.id, result.status, result.error);
    checked++;
    if (result.status === "healthy") healthy++;
    else unhealthy++;
  }
  return { checked, healthy, unhealthy };
}

// POST /api/backends — register a file backend. Without lobby_id it is a
// personal (自建) backend owned by the caller; with lobby_id it becomes the
// lobby's (大厅) backend and requires owner/admin role there.
export async function registerBackend(request: Request, env: Env): Promise<Response> {
  const tooBig = checkBodySize(request, 4 * 1024);
  if (tooBig) return tooBig;
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  let body: { base_url?: unknown; name?: unknown; lobby_id?: unknown; upload_secret?: unknown };
  try {
    body = await request.json();
  } catch {
    return err("invalid JSON body");
  }
  const baseURL = typeof body.base_url === "string" ? body.base_url.trim().replace(/\/+$/, "") : "";
  if (!validBackendURL(baseURL)) {
    return err("base_url must be a plain http(s) URL without credentials/query (max 255 chars)");
  }
  const name = typeof body.name === "string" ? body.name.slice(0, 64) : "";
  const lobbyId = typeof body.lobby_id === "string" && body.lobby_id !== "" ? body.lobby_id : null;
  // Capability secret: same value the operator passes to the backend's
  // --upload-secret. Optional (empty = open backend); enforce a minimum so a
  // configured secret is not trivially guessable, and cap the length.
  const uploadSecret = typeof body.upload_secret === "string" ? body.upload_secret : "";
  if (uploadSecret !== "" && (uploadSecret.length < 16 || uploadSecret.length > 128)) {
    return err("upload_secret must be 16..128 characters when set");
  }

  if (lobbyId) {
    const member = await env.DB
      .prepare("SELECT role FROM lobby_members WHERE lobby_id = ? AND user_id = ?")
      .bind(lobbyId, auth.sub)
      .first<{ role: string }>();
    if (!member || (member.role !== "owner" && member.role !== "admin")) {
      return err("Only lobby owner/admin can register a lobby backend", 403);
    }
  }

  const id = generateId();
  const now = Math.floor(Date.now() / 1000);
  await env.DB
    .prepare(
      "INSERT INTO file_backends (id, owner_id, lobby_id, name, base_url, upload_secret, active, created_at) VALUES (?,?,?,?,?,?,1,?)",
    )
    .bind(id, auth.sub, lobbyId, name, baseURL, uploadSecret, now)
    .run();

  log({ event: "backends.registered", backend_id: id, user_id: auth.sub, lobby_id: lobbyId ?? "" });
  return json({
    id,
    owner_id: auth.sub,
    lobby_id: lobbyId,
    name,
    base_url: baseURL,
    active: 1,
    created_at: now,
    health_status: "unknown",
    last_health_at: null,
    last_health_error: null,
  }, 201);
}

// GET /api/backends — every backend visible to the caller, annotated with how
// they can use it: own (自建), shared (分享给我的), lobby (大厅, via membership).
export async function listBackends(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  // Explicit column list — upload_secret must never leave the DB via list
  // responses (it is the backend's write/read credential).
  const cols =
    "b.id, b.owner_id, b.lobby_id, b.name, b.base_url, b.active, b.created_at, " +
    "b.health_status, b.last_health_at, b.last_health_error";
  // As in resolution, begin at the caller's ownership, shares or memberships
  // rather than the global active-backend/NULL-lobby ranges.
  const rows = await env.DB
    .prepare(
      `SELECT ${cols}, 'own' AS via FROM file_backends b INDEXED BY idx_file_backends_owner
         WHERE b.owner_id = ? AND b.lobby_id IS NULL AND b.active = 1
       UNION ALL
       SELECT ${cols}, 'shared' AS via FROM file_backend_shares s INDEXED BY idx_backend_shares_grantee
         CROSS JOIN file_backends b ON b.id = s.backend_id
         WHERE s.grantee_id = ? AND b.lobby_id IS NULL AND b.active = 1
       UNION ALL
       SELECT ${cols}, 'lobby' AS via FROM lobby_members m INDEXED BY idx_lobby_members_user
         CROSS JOIN file_backends b INDEXED BY idx_file_backends_lobby ON b.lobby_id = m.lobby_id
         WHERE m.user_id = ? AND b.active = 1
       ORDER BY created_at DESC`,
    )
    .bind(auth.sub, auth.sub, auth.sub)
    .all();
  return json({ backends: rows.results ?? [] });
}

// DELETE /api/backends/:id — deactivate (soft) a backend. Owner only. Files
// already stored on it keep their backend_id row for auditability; downloads
// of those files return 503 until the backend is re-registered.
export async function deactivateBackend(request: Request, env: Env, backendId: string): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const res = await env.DB
    .prepare("UPDATE file_backends SET active = 0 WHERE id = ? AND owner_id = ? AND active = 1")
    .bind(backendId, auth.sub)
    .run();
  if (!res.meta || res.meta.changes === 0) return err("backend not found", 404);
  log({ event: "backends.deactivated", backend_id: backendId, user_id: auth.sub });
  return json({ ok: true });
}

// POST /api/backends/:id/shares — share a personal backend with another user
// (the 分享 tier). Owner only; lobby backends are already visible to members
// and cannot be shared individually.
export async function shareBackend(request: Request, env: Env, backendId: string): Promise<Response> {
  const tooBig = checkBodySize(request, 4 * 1024);
  if (tooBig) return tooBig;
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  let body: { user_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return err("invalid JSON body");
  }
  const granteeId = typeof body.user_id === "string" ? body.user_id.trim() : "";
  if (!granteeId || granteeId.length > 64) return err("user_id required");
  if (granteeId === auth.sub) return err("cannot share a backend with yourself");

  const backend = await env.DB
    .prepare("SELECT owner_id, lobby_id, active FROM file_backends WHERE id = ?")
    .bind(backendId)
    .first<{ owner_id: string; lobby_id: string | null; active: number }>();
  if (!backend || backend.active !== 1) return err("backend not found", 404);
  if (backend.owner_id !== auth.sub) return err("only the owner can share a backend", 403);
  if (backend.lobby_id) return err("lobby backends are shared via membership", 400);

  const now = Math.floor(Date.now() / 1000);
  await env.DB
    .prepare("INSERT OR IGNORE INTO file_backend_shares (backend_id, grantee_id, created_at) VALUES (?,?,?)")
    .bind(backendId, granteeId, now)
    .run();
  return json({ ok: true }, 201);
}

// DELETE /api/backends/:id/shares/:userId — revoke a share. Owner only.
export async function unshareBackend(
  request: Request,
  env: Env,
  backendId: string,
  granteeId: string,
): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const backend = await env.DB
    .prepare("SELECT owner_id FROM file_backends WHERE id = ?")
    .bind(backendId)
    .first<{ owner_id: string }>();
  if (!backend) return err("backend not found", 404);
  if (backend.owner_id !== auth.sub) return err("only the owner can revoke a share", 403);

  const res = await env.DB
    .prepare("DELETE FROM file_backend_shares WHERE backend_id = ? AND grantee_id = ?")
    .bind(backendId, granteeId)
    .run();
  if (!res.meta || res.meta.changes === 0) return err("share not found", 404);
  return json({ ok: true });
}
