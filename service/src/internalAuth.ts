// Service-side verification of control → service internal-call signatures
// (G6 upgrade). Counterpart of control/src/internalAuth.ts — keep the wire
// contract in sync:
//
//   X-Internal-Ts:    unix seconds at signing time
//   X-Internal-Nonce: 16 random bytes, hex
//   X-Internal-Sig:   base64url(HMAC-SHA256(secret, ts \n nonce \n METHOD \n pathname+search))
//
// Freshness: |now - ts| must be ≤ INTERNAL_SIG_WINDOW_SEC. Replay: nonces seen
// inside the window are rejected. The nonce cache is per-isolate memory —
// Workers isolates don't share state, so a captured header set could in theory
// be replayed against a *different* isolate within the window. That residual
// risk is bounded to 2×window seconds and one request per isolate, versus the
// previous static bearer where one capture was a permanent credential; a
// D1/KV-backed nonce table can close it later if needed.
//
// TODO(proto): shared contract duplicated from control/src/internalAuth.ts;
// move to proto/ when that becomes the source of truth.

import { constantTimeEqual, hmacSign } from "./auth";

export const INTERNAL_SIG_WINDOW_SEC = 90;

const NONCE_CACHE_MAX = 4096;
const seenNonces = new Map<string, number>(); // nonce -> expiry unix seconds

function sweepNonces(now: number): void {
  if (seenNonces.size <= NONCE_CACHE_MAX) return;
  for (const [nonce, expiry] of seenNonces) {
    if (expiry <= now) seenNonces.delete(nonce);
  }
  // Pathological flood: drop oldest entries wholesale rather than grow.
  if (seenNonces.size > NONCE_CACHE_MAX) {
    const excess = seenNonces.size - NONCE_CACHE_MAX;
    let i = 0;
    for (const nonce of seenNonces.keys()) {
      if (i++ >= excess) break;
      seenNonces.delete(nonce);
    }
  }
}

// verifyInternalRequest checks the HMAC(ts+nonce+method+path) headers on an
// internal request. Returns true only for a fresh, unreplayed, correctly
// signed request. `nowSec` is injectable for tests.
export async function verifyInternalRequest(
  request: Request,
  secret: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const ts = request.headers.get("X-Internal-Ts") ?? "";
  const nonce = request.headers.get("X-Internal-Nonce") ?? "";
  const sig = request.headers.get("X-Internal-Sig") ?? "";
  if (!ts || !nonce || !sig || !secret) return false;
  if (!/^\d{1,12}$/.test(ts) || !/^[0-9a-f]{32}$/.test(nonce)) return false;

  const tsNum = parseInt(ts, 10);
  if (Math.abs(nowSec - tsNum) > INTERNAL_SIG_WINDOW_SEC) return false;

  const u = new URL(request.url);
  const payload = `${ts}\n${nonce}\n${request.method.toUpperCase()}\n${u.pathname}${u.search}`;
  const expected = await hmacSign(secret, payload);
  if (!constantTimeEqual(sig, expected)) return false;

  // Replay check last, so an unauthenticated flood can't poison the cache.
  const cached = seenNonces.get(nonce);
  if (cached !== undefined && cached > nowSec) return false;
  seenNonces.set(nonce, nowSec + 2 * INTERNAL_SIG_WINDOW_SEC);
  sweepNonces(nowSec);
  return true;
}
