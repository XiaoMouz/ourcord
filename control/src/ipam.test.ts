import { describe, it, expect } from "vitest";
import { uint32ToIPv4, ipsForOffset, isUniqueViolation } from "./ipam";

describe("uint32ToIPv4", () => {
  it("formats 0", () => {
    expect(uint32ToIPv4(0)).toBe("0.0.0.0");
  });
  it("formats max", () => {
    expect(uint32ToIPv4(0xffffffff)).toBe("255.255.255.255");
  });
  it("formats 100.64.0.0 base", () => {
    const base = (100 << 24) | (64 << 16);
    expect(uint32ToIPv4(base)).toBe("100.64.0.0");
  });
  it("formats 100.64.0.5 (offset 5 in pool)", () => {
    const base = (100 << 24) | (64 << 16);
    expect(uint32ToIPv4(base + 5)).toBe("100.64.0.5");
  });
});

describe("ipsForOffset", () => {
  it("rejects offset < 2 (network/gateway reserved)", () => {
    expect(() => ipsForOffset(0)).toThrow(/out of pool range/);
    expect(() => ipsForOffset(1)).toThrow(/out of pool range/);
  });
  it("rejects offset > /10 mask", () => {
    expect(() => ipsForOffset(0x400000)).toThrow(/out of pool range/);
  });
  it("returns valid pair for offset=2", () => {
    const { ip4, ip6, offset } = ipsForOffset(2);
    expect(ip4).toBe("100.64.0.2");
    expect(ip6).toBe("fd7a:115c:a1e0:0000::0002");
    expect(offset).toBe(2);
  });
  it("composes hi/lo into v6 correctly for high offset", () => {
    // offset 0x12345 => hi=0x0001, lo=0x2345
    const { ip6 } = ipsForOffset(0x12345);
    expect(ip6).toBe("fd7a:115c:a1e0:0001::2345");
  });
  it("v4 and v6 share the same offset bits", () => {
    const { ip4, ip6 } = ipsForOffset(258);
    expect(ip4).toBe("100.64.1.2");
    expect(ip6).toBe("fd7a:115c:a1e0:0000::0102");
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
