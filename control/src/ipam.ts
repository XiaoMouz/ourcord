import { Env } from "./types";

// U1: VPN address pool: 198.18.0.0/15 (RFC 2544 benchmark range).
// Chosen over 100.64.0.0/10 because:
//   - 100.64/10 is the Tailscale default pool (same-host install would clash)
//   - 100.64/10 is also actively used by Chinese ISPs for residential CGNAT,
//     so the host kernel may already have a route for it that we'd shadow.
//   - 198.18.0.0/15 (RFC 2544) is reserved for benchmarking and almost never
//     deployed in production networks, so collisions are vanishingly rare.
// 131072 addresses is plenty for our small-group product (5-10 users / lobby).
const VPN_SUBNET_START = (198 << 24) | (18 << 16); // 198.18.0.0
const VPN_SUBNET_MASK = 0x1ffff; // /15 → 2^17 - 1 = 131071

// U3: allocate from the upper /16 (198.19.0.0/16) first. Clash/mihomo's
// default DNS `fake-ip-range` is 198.18.0.1/16 — exactly the lower half of
// our pool — and both sides hand out addresses sequentially from the bottom,
// so a daemon's own /32 host route would shadow the proxy's fake IP for
// e.g. the control-plane hostname (black-holing it). Keeping allocations in
// 198.19.x.x makes OurCord coexist with a default-configured Clash; the
// lower /16 remains only as an exhaustion fallback.
const UPPER_HALF_FIRST_OFFSET = 0x10000 + 2; // 198.19.0.2 (skip .0/.1 like the lower half)

// U1/U2: IPv6 ULA prefix is per-deployment, NOT a hardcoded constant.
// fd7a:115c:a1e0::/48 is Tailscale's well-known prefix; we used to reuse it
// (causing the same conflict as the v4 issue above). Each deployment now
// generates its own random fd<XX>:<XXXX>:<XXXX>::/48 on first peer registration
// and persists it in KV. Per RFC 4193: fd00::/8 + 40 random bits = /48.
const COUNTER_KEY = "vpn_ip_counter";
const ULA_PREFIX_KEY = "vpn_ula_prefix";

export function uint32ToIPv4(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

export interface AllocatedIP {
  ip4: string;
  ip6: string;
  offset: number;
}

// Build the {ip4, ip6} pair for a given offset within the pool.
// `ulaPrefix` MUST be a 3-group ULA prefix ending with ":" (e.g. "fd12:3456:789a:")
// — the offset's high 16 bits become group 4 (subnet ID) and low 16 bits the
// last v6 group (interface ID). Get one from `getULAPrefix(env)`.
export function ipsForOffset(offset: number, ulaPrefix: string): AllocatedIP {
  if (offset < 2 || offset > VPN_SUBNET_MASK) {
    throw new Error(`offset ${offset} out of pool range`);
  }
  if (!/^fd[0-9a-f]{2}:[0-9a-f]{1,4}:[0-9a-f]{1,4}:$/i.test(ulaPrefix)) {
    throw new Error(`invalid ULA prefix: ${ulaPrefix}`);
  }
  const ip4 = uint32ToIPv4(VPN_SUBNET_START + offset);
  const hi = (offset >> 16) & 0xffff;
  const lo = offset & 0xffff;
  const ip6 = `${ulaPrefix}${hi.toString(16).padStart(4, "0")}::${lo.toString(16).padStart(4, "0")}`;
  return { ip4, ip6, offset };
}

// generateULAPrefix returns a freshly random RFC 4193 ULA /48 prefix string
// suitable for passing to ipsForOffset, e.g. "fdab:cdef:0123:".
// Uses crypto.getRandomValues which is available in the Workers runtime.
export function generateULAPrefix(): string {
  const bytes = new Uint8Array(5);
  crypto.getRandomValues(bytes);
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  // fd<b0>:<b1b2>:<b3b4>:
  return `fd${hex(bytes[0])}:${hex(bytes[1])}${hex(bytes[2])}:${hex(bytes[3])}${hex(bytes[4])}:`;
}

// getULAPrefix lazily initializes and returns the deployment-wide ULA prefix.
// Persisted in KV so all peers in this deployment share the same /48.
// Phase-2 will extend this to per-lobby allocation.
export async function getULAPrefix(kv: KVNamespace): Promise<string> {
  const existing = await kv.get(ULA_PREFIX_KEY);
  if (existing && /^fd[0-9a-f]{2}:[0-9a-f]{1,4}:[0-9a-f]{1,4}:$/i.test(existing)) {
    return existing;
  }
  const fresh = generateULAPrefix();
  // Best-effort write; if a parallel registration also wrote one we re-read
  // to converge on a single prefix (race window narrow but possible).
  await kv.put(ULA_PREFIX_KEY, fresh);
  const settled = await kv.get(ULA_PREFIX_KEY);
  return settled ?? fresh;
}

// nextOffset advances the allocation walk: up through the 198.19 half to the
// pool end, then wraps into the 198.18 fallback half. Callers treat this as a
// hint stream only — the UNIQUE constraints on peers.ip4/ip6 stay the source
// of truth.
export function nextOffset(offset: number): number {
  if (!Number.isFinite(offset) || offset < 2) return UPPER_HALF_FIRST_OFFSET;
  const next = offset + 1;
  return next > VPN_SUBNET_MASK ? 2 : next;
}

// nextCandidateOffset returns the KV counter hint (198.19.0.2 on first call).
// This is a HINT only — the caller MUST handle UNIQUE constraint failures
// in the peers.ip4/ip6 columns by retrying with nextOffset().
// commitOffset keeps the max, so a counter below the upper-half start can only
// mean a deployment that allocated under the old lower-half-first policy (or a
// fresh one); clamp it up so new peers land in 198.19.x. The wrapped-exhausted
// state is unrepresentable in a max-counter, but walking past 65534 upper-half
// addresses is out of scope for a 5-10 person product.
export async function nextCandidateOffset(kv: KVNamespace): Promise<number> {
  const raw = await kv.get(COUNTER_KEY);
  let offset = raw ? nextOffset(parseInt(raw, 10)) : UPPER_HALF_FIRST_OFFSET;
  if (offset < UPPER_HALF_FIRST_OFFSET) offset = UPPER_HALF_FIRST_OFFSET;
  return offset;
}

// commitOffset records the high-water mark so future calls don't rescan from 0.
export async function commitOffset(kv: KVNamespace, offset: number): Promise<void> {
  // Best-effort. If two writers race we pick the larger.
  const existing = await kv.get(COUNTER_KEY);
  const cur = existing ? parseInt(existing, 10) : 0;
  if (offset > cur) {
    await kv.put(COUNTER_KEY, String(offset));
  }
}

// isUniqueViolation detects D1's "UNIQUE constraint failed" error from a thrown error.
export function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

// (allocateVPNIP removed — see G17. The previous KV-counter-only allocation
// was never atomic across concurrent registrations and was superseded by
// insertWithIPRetry in peers.ts which uses candidate-offset + UNIQUE retry.)
