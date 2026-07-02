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
import { requireAuth, generateId, json, err, checkBodySize } from "./auth";
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
// slashes; storage_key never starts with "/" (see files.ts).
export function joinBackendURL(baseURL: string, storageKey: string): string {
  return `${baseURL.replace(/\/+$/, "")}/${storageKey}`;
}

// resolveFileBackend walks 自建 → 分享 → 大厅 → R2 and returns the first
// usable tier. `preference` (from the upload request) reorders the walk but
// never bypasses policy switches or conjures a backend that isn't registered:
// a tier with no live backend simply falls through — that fall-through is the
// autonomy: losing your own server degrades to a friend's, the lobby's, R2.
export async function resolveFileBackend(
  env: Env,
  uploaderId: string,
  lobbyId: string,
  policy: FilePolicy,
  preference?: "user_server" | "lobby_server" | "r2",
): Promise<{ location: "user_server" | "lobby_server" | "r2"; backend: FileBackend | null } | null> {
  type Tier = "user_server" | "lobby_server" | "r2";
  const chain: Tier[] = ["user_server", "lobby_server", "r2"];
  const ordered: Tier[] = preference ? [preference, ...chain.filter((t) => t !== preference)] : chain;

  for (const tier of ordered) {
    if (tier === "user_server" && policy.user_server_enabled === 1) {
      // 自建: the uploader's own personal backend wins first…
      const own = await env.DB
        .prepare(
          `SELECT * FROM file_backends
           WHERE owner_id = ? AND lobby_id IS NULL AND active = 1
           ORDER BY created_at DESC LIMIT 1`,
        )
        .bind(uploaderId)
        .first<FileBackend>();
      if (own) return { location: "user_server", backend: own };
      // …then 分享: a personal backend someone shared with the uploader.
      const shared = await env.DB
        .prepare(
          `SELECT b.* FROM file_backends b
           JOIN file_backend_shares s ON s.backend_id = b.id
           WHERE s.grantee_id = ? AND b.lobby_id IS NULL AND b.active = 1
           ORDER BY s.created_at DESC LIMIT 1`,
        )
        .bind(uploaderId)
        .first<FileBackend>();
      if (shared) return { location: "user_server", backend: shared };
    } else if (tier === "lobby_server" && policy.lobby_server_enabled === 1) {
      const lobby = await env.DB
        .prepare(
          `SELECT * FROM file_backends
           WHERE lobby_id = ? AND active = 1
           ORDER BY created_at DESC LIMIT 1`,
        )
        .bind(lobbyId)
        .first<FileBackend>();
      if (lobby) return { location: "lobby_server", backend: lobby };
    } else if (tier === "r2" && policy.r2_enabled === 1) {
      return { location: "r2", backend: null };
    }
  }
  return null;
}

// POST /api/backends — register a file backend. Without lobby_id it is a
// personal (自建) backend owned by the caller; with lobby_id it becomes the
// lobby's (大厅) backend and requires owner/admin role there.
export async function registerBackend(request: Request, env: Env): Promise<Response> {
  const tooBig = checkBodySize(request, 4 * 1024);
  if (tooBig) return tooBig;
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  let body: { base_url?: unknown; name?: unknown; lobby_id?: unknown };
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
      "INSERT INTO file_backends (id, owner_id, lobby_id, name, base_url, active, created_at) VALUES (?,?,?,?,?,1,?)",
    )
    .bind(id, auth.sub, lobbyId, name, baseURL, now)
    .run();

  log({ event: "backends.registered", backend_id: id, user_id: auth.sub, lobby_id: lobbyId ?? "" });
  return json({ id, owner_id: auth.sub, lobby_id: lobbyId, name, base_url: baseURL, active: 1, created_at: now }, 201);
}

// GET /api/backends — every backend visible to the caller, annotated with how
// they can use it: own (自建), shared (分享给我的), lobby (大厅, via membership).
export async function listBackends(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const rows = await env.DB
    .prepare(
      `SELECT b.*, 'own' AS via FROM file_backends b
         WHERE b.owner_id = ? AND b.lobby_id IS NULL AND b.active = 1
       UNION ALL
       SELECT b.*, 'shared' AS via FROM file_backends b
         JOIN file_backend_shares s ON s.backend_id = b.id
         WHERE s.grantee_id = ? AND b.lobby_id IS NULL AND b.active = 1
       UNION ALL
       SELECT b.*, 'lobby' AS via FROM file_backends b
         JOIN lobby_members m ON m.lobby_id = b.lobby_id
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
