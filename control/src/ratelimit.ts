import type { Env } from "./types";
import { json } from "./auth";

export type RateLimitBindings = Partial<Record<`RATE_LIMIT_${5 | 10 | 20 | 30 | 60 | 120}`, RateLimit>>;

// Native counters avoid KV read/write amplification and KV's per-key write
// limit. They are approximate and per Cloudflare location, not a global budget.
export async function checkRateLimit(
  request: Request,
  env: Env,
  bucket: string,
  limit: 5 | 10 | 20 | 30 | 60 | 120,
  windowSec: 60,
): Promise<Response | null> {
  const limiter = env[`RATE_LIMIT_${limit}`];
  if (!limiter) {
    if (env.ENVIRONMENT === "development") return null;
    return json({ error: "rate limiter unavailable" }, 503);
  }
  const ip = request.headers.get("cf-connecting-ip") ?? "anon";
  const { success } = await limiter.limit({ key: `${bucket}:${ip}` });
  if (success) return null;
  const response = json({ error: "rate limit exceeded", retry_after: windowSec }, 429);
  response.headers.set("Retry-After", String(windowSec));
  return response;
}
