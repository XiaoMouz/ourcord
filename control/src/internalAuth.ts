// Control → service internal-call signing (G6 upgrade).
//
// Instead of shipping the shared secret itself as a bearer header (capture
// once = permanent credential), each internal request carries a short-lived
// HMAC signature binding timestamp + nonce + method + path. The service side
// verifies freshness (±INTERNAL_SIG_WINDOW_SEC) and rejects nonce replays, so
// a captured header set is useless outside a small window and unusable twice.
//
// Wire format (headers):
//   X-Internal-Ts:    unix seconds at signing time
//   X-Internal-Nonce: 16 random bytes, hex
//   X-Internal-Sig:   base64url(HMAC-SHA256(secret, ts \n nonce \n METHOD \n pathname+search))
//
// The signing string derives pathname+search via the URL parser on BOTH sides
// so percent-encoding normalization can't cause mismatches.
//
// TODO(proto): this contract is duplicated in service/src/internalAuth.ts;
// move the shared definition to proto/ when that becomes the source of truth.

export const INTERNAL_SIG_WINDOW_SEC = 90;

async function hmacSignB64url(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export function internalSigPayload(ts: string, nonce: string, method: string, url: string): string {
  const u = new URL(url);
  return `${ts}\n${nonce}\n${method.toUpperCase()}\n${u.pathname}${u.search}`;
}

// signInternalHeaders returns the three headers an internal control→service
// request must carry. `url` is the full request URL (host part is not signed;
// the path is what scopes the authorization).
export async function signInternalHeaders(
  secret: string,
  method: string,
  url: string,
): Promise<Record<string, string>> {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  const nonce = [...nonceBytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const sig = await hmacSignB64url(secret, internalSigPayload(ts, nonce, method, url));
  return {
    "X-Internal-Ts": ts,
    "X-Internal-Nonce": nonce,
    "X-Internal-Sig": sig,
  };
}
