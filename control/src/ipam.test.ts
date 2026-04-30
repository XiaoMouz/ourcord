import { describe, it, expect } from "vitest";
import {
  uint32ToIPv4,
  ipsForOffset,
  isUniqueViolation,
  generateULAPrefix,
  getULAPrefix,
} from "./ipam";

const TEST_PREFIX = "fdab:cdef:0123:";

describe("uint32ToIPv4", () => {
  it("formats 0", () => {
    expect(uint32ToIPv4(0)).toBe("0.0.0.0");
  });
  it("formats max", () => {
    expect(uint32ToIPv4(0xffffffff)).toBe("255.255.255.255");
  });
  it("formats 198.18.0.0 base", () => {
    const base = (198 << 24) | (18 << 16);
    expect(uint32ToIPv4(base)).toBe("198.18.0.0");
  });
  it("formats 198.18.0.5 (offset 5 in pool)", () => {
    const base = (198 << 24) | (18 << 16);
    expect(uint32ToIPv4(base + 5)).toBe("198.18.0.5");
  });
});

describe("ipsForOffset", () => {
  it("rejects offset < 2 (network/gateway reserved)", () => {
    expect(() => ipsForOffset(0, TEST_PREFIX)).toThrow(/out of pool range/);
    expect(() => ipsForOffset(1, TEST_PREFIX)).toThrow(/out of pool range/);
  });
  it("rejects offset > /15 mask", () => {
    // 0x20000 is just past the /15 mask (0x1FFFF)
    expect(() => ipsForOffset(0x20000, TEST_PREFIX)).toThrow(/out of pool range/);
  });
  it("accepts offset at /15 boundary", () => {
    expect(() => ipsForOffset(0x1ffff, TEST_PREFIX)).not.toThrow();
  });
  it("rejects malformed ULA prefix", () => {
    expect(() => ipsForOffset(2, "fc12:3456:7890:")).toThrow(/invalid ULA prefix/); // not fd
    expect(() => ipsForOffset(2, "fd12:3456:7890")).toThrow(/invalid ULA prefix/);  // missing trailing :
    expect(() => ipsForOffset(2, "fdzz:3456:7890:")).toThrow(/invalid ULA prefix/); // non-hex
  });
  it("returns valid pair for offset=2", () => {
    const { ip4, ip6, offset } = ipsForOffset(2, TEST_PREFIX);
    expect(ip4).toBe("198.18.0.2");
    expect(ip6).toBe("fdab:cdef:0123:0000::0002");
    expect(offset).toBe(2);
  });
  it("composes hi/lo into v6 correctly for high offset", () => {
    // offset 0x12345 => hi=0x0001, lo=0x2345
    const { ip6 } = ipsForOffset(0x12345, TEST_PREFIX);
    expect(ip6).toBe("fdab:cdef:0123:0001::2345");
  });
  it("v4 and v6 share the same offset bits", () => {
    const { ip4, ip6 } = ipsForOffset(258, TEST_PREFIX);
    expect(ip4).toBe("198.18.1.2");
    expect(ip6).toBe("fdab:cdef:0123:0000::0102");
  });
});

describe("generateULAPrefix", () => {
  it("returns RFC 4193 fd00::/8 prefix shape ending in colon", () => {
    const p = generateULAPrefix();
    expect(p).toMatch(/^fd[0-9a-f]{2}:[0-9a-f]{4}:[0-9a-f]{4}:$/);
  });
  it("is sufficiently random across calls", () => {
    const samples = new Set<string>();
    for (let i = 0; i < 32; i++) samples.add(generateULAPrefix());
    // 32 random 40-bit values colliding is astronomically unlikely
    expect(samples.size).toBe(32);
  });
  it("output is accepted by ipsForOffset", () => {
    const p = generateULAPrefix();
    const { ip6 } = ipsForOffset(2, p);
    expect(ip6.startsWith(p)).toBe(true);
  });
});

describe("getULAPrefix", () => {
  function fakeKV(): KVNamespace {
    const store = new Map<string, string>();
    return {
      async get(k: string) {
        return store.get(k) ?? null;
      },
      async put(k: string, v: string) {
        store.set(k, v);
      },
      async delete(k: string) {
        store.delete(k);
      },
      async list() {
        return { keys: [], list_complete: true, cacheStatus: null };
      },
      async getWithMetadata() {
        return { value: null, metadata: null, cacheStatus: null };
      },
    } as unknown as KVNamespace;
  }

  it("generates and persists on first call", async () => {
    const kv = fakeKV();
    const p1 = await getULAPrefix(kv);
    expect(p1).toMatch(/^fd[0-9a-f]{2}:[0-9a-f]{4}:[0-9a-f]{4}:$/);
    const stored = await kv.get("vpn_ula_prefix");
    expect(stored).toBe(p1);
  });
  it("returns the same prefix on subsequent calls", async () => {
    const kv = fakeKV();
    const p1 = await getULAPrefix(kv);
    const p2 = await getULAPrefix(kv);
    const p3 = await getULAPrefix(kv);
    expect(p2).toBe(p1);
    expect(p3).toBe(p1);
  });
  it("regenerates if stored value is malformed", async () => {
    const kv = fakeKV();
    await kv.put("vpn_ula_prefix", "garbage-not-a-prefix");
    const p = await getULAPrefix(kv);
    expect(p).toMatch(/^fd[0-9a-f]{2}:[0-9a-f]{4}:[0-9a-f]{4}:$/);
    expect(p).not.toBe("garbage-not-a-prefix");
  });
});

describe("isUniqueViolation", () => {
  it("matches D1 'UNIQUE constraint failed'", () => {
    expect(isUniqueViolation(new Error("D1_ERROR: UNIQUE constraint failed: peers.ip4"))).toBe(true);
  });
  it("matches SQLITE_CONSTRAINT", () => {
    expect(isUniqueViolation(new Error("SQLITE_CONSTRAINT_UNIQUE"))).toBe(true);
  });
  it("matches case-insensitively", () => {
    expect(isUniqueViolation(new Error("unique constraint failed"))).toBe(true);
  });
  it("does not match unrelated errors", () => {
    expect(isUniqueViolation(new Error("network timeout"))).toBe(false);
    expect(isUniqueViolation("string error")).toBe(false);
  });
});
