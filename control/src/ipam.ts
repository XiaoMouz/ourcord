import { Env } from "./types";

// VPN address pool: 100.64.0.0/10 (CGNAT range, same as Tailscale)
const VPN_SUBNET_START = (100 << 24) | (64 << 16); // 100.64.0.0
const VPN_SUBNET_MASK = 0x3fffff; // /10 gives 4M addresses
const VPN_IPV6_PREFIX = "fd7a:115c:a1e0:"; // ULA prefix for VPN

const COUNTER_KEY = "vpn_ip_counter";

export function uint32ToIPv4(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

export interface AllocatedIP {
  ip4: string;
  ip6: string;
  offset: number;
}

// Build the {ip4, ip6} pair for a given offset within the pool.
export function ipsForOffset(offset: number): AllocatedIP {
  if (offset < 2 || offset > VPN_SUBNET_MASK) {
    throw new Error(`offset ${offset} out of pool range`);
  }
  const ip4 = uint32ToIPv4(VPN_SUBNET_START + offset);
  const hi = (offset >> 16) & 0xffff;
  const lo = offset & 0xffff;
  const ip6 = `${VPN_IPV6_PREFIX}${hi.toString(16).padStart(4, "0")}::${lo.toString(16).padStart(4, "0")}`;
  return { ip4, ip6, offset };
}

// nextCandidateOffset returns the KV counter hint (or 2 on first call).
// This is a HINT only — the caller MUST handle UNIQUE constraint failures
// in the peers.ip4/ip6 columns by retrying with the next offset.
export async function nextCandidateOffset(kv: KVNamespace): Promise<number> {
  const raw = await kv.get(COUNTER_KEY);
  let offset = raw ? parseInt(raw, 10) + 1 : 2; // skip .0 (network) and .1 (gateway-reserved)
  if (!Number.isFinite(offset) || offset < 2) offset = 2;
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

// allocateVPNIP is kept for backwards compatibility but the recommended path
// is now insertWithIPRetry in peers.ts: candidate offset → INSERT → retry on
// UNIQUE → commit counter. The KV counter alone is NOT atomic across
// concurrent registrations.
export async function allocateVPNIP(
  kv: KVNamespace,
  _db: D1Database,
): Promise<{ ip4: string; ip6: string }> {
  const offset = await nextCandidateOffset(kv);
  const { ip4, ip6 } = ipsForOffset(offset);
  await commitOffset(kv, offset);
  return { ip4, ip6 };
}
