import { Env } from "./types";

// VPN address pool: 100.64.0.0/10 (CGNAT range, same as Tailscale)
const VPN_SUBNET_START = (100 << 24) | (64 << 16); // 100.64.0.0
const VPN_SUBNET_MASK = 0x3fffff; // /10 gives 4M addresses
const VPN_IPV6_PREFIX = "fd7a:115c:a1e0:"; // ULA prefix for VPN

export function uint32ToIPv4(n: number): string {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
}

// Allocate a unique VPN IPv4 from the 100.64.0.0/10 pool
// Uses a simple counter stored in KV, with collision fallback
export async function allocateVPNIP(kv: KVNamespace, db: D1Database): Promise<{ ip4: string; ip6: string }> {
  // Get next available offset from KV counter
  const counterKey = "vpn_ip_counter";
  const raw = await kv.get(counterKey);
  let offset = raw ? parseInt(raw, 10) + 1 : 1;

  // Skip .0 and .1 (network/gateway), cap at pool size
  if (offset > VPN_SUBNET_MASK) throw new Error("VPN IP pool exhausted");

  // Check this IP isn't already assigned
  const ip4 = uint32ToIPv4(VPN_SUBNET_START + offset);
  const existing = await db
    .prepare("SELECT id FROM peers WHERE ip4 = ?")
    .bind(ip4)
    .first<{ id: string }>();
  if (existing) {
    // Increment and retry (simple linear probe)
    offset++;
    if (offset > VPN_SUBNET_MASK) throw new Error("VPN IP pool exhausted");
  }

  await kv.put(counterKey, String(offset));

  // Derive IPv6 from offset: fd7a:115c:a1e0:ab12::/64 style
  const hi = (offset >> 16) & 0xffff;
  const lo = offset & 0xffff;
  const ip6 = `${VPN_IPV6_PREFIX}${hi.toString(16).padStart(4, "0")}::${lo.toString(16).padStart(4, "0")}`;

  return { ip4, ip6 };
}
