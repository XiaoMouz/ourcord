import type { Env } from "./types";

// Token-bucket-ish via fixed-window KV counter. Lightweight: one KV read +
// at most one KV write per request. Key TTL = window seconds + small buffer.
//
// Returns null when allowed; returns a 429 Response when over limit.
//
// Caller must `return` the Response if non-null.
export async function checkRateLimit(
  request: Request,
  env: Env,
  bucket: string,
  limit: number,
  windowSec: number,
): Promise<Response | null> {
  // Skip when KV is unavailable (e.g. tests). KV is the only side-effect.
  if (!env.KV) return null;

  // Cloudflare Workers expose the client IP via cf-connecting-ip; in dev
  // (workerd / wrangler) this header may be missing — fall back to a
  // bucket-wide counter so the limit still applies (worst case shared cap).
  const ip = request.headers.get("cf-connecting-ip") ?? "anon";

  // Bucket the timestamp to the window so concurrent requests share the
  // same counter for the duration of the window.
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSec);
  const key = `ratelimit:${bucket}:${ip}:${windowStart}`;

  const raw = await env.KV.get(key);
  const count = raw ? parseInt(raw, 10) : 0;

  if (count >= limit) {
    const retryAfter = windowStart + windowSec - now;
    return new Response(
      JSON.stringify({ error: "rate limit exceeded", retry_after: retryAfter }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(Math.max(retryAfter, 1)),
        },
      },
    );
  }

  // Race: two requests both read N, both write N+1; observed cap is +1
  // over the configured limit. Acceptable; matches the OTP quota pattern
  // already in authHandler.ts.
  await env.KV.put(key, String(count + 1), { expirationTtl: windowSec + 60 });
  return null;
}
