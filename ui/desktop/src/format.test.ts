import { describe, it, expect } from "vitest";
import { shortKey, relativeTime, pathTone } from "./format";

describe("shortKey", () => {
  it("abbreviates long keys", () => {
    expect(shortKey("ABCDEFGH12345678IJKLMNOP")).toBe("ABCDEFGH…KLMNOP");
  });
  it("leaves short strings and empties alone", () => {
    expect(shortKey("short")).toBe("short");
    expect(shortKey(undefined)).toBe("—");
  });
});

describe("relativeTime", () => {
  const now = 1_000_000 * 1000; // fixed now in ms
  it("renders coarse buckets", () => {
    expect(relativeTime(1_000_000 - 5, now)).toBe("5 秒前");
    expect(relativeTime(1_000_000 - 120, now)).toBe("2 分钟前");
    expect(relativeTime(1_000_000 - 7200, now)).toBe("2 小时前");
    expect(relativeTime(1_000_000 - 172800, now)).toBe("2 天前");
  });
  it("handles now/future/empty", () => {
    expect(relativeTime(1_000_000 + 10, now)).toBe("刚刚");
    expect(relativeTime(0, now)).toBe("—");
    expect(relativeTime(null, now)).toBe("—");
  });
});

describe("pathTone", () => {
  it("classifies known paths", () => {
    expect(pathTone("direct")).toBe("good");
    expect(pathTone("derp")).toBe("fair");
    expect(pathTone("degraded")).toBe("poor");
  });
  it("defaults unknown/absent to wait", () => {
    expect(pathTone("mystery")).toBe("wait");
    expect(pathTone(undefined)).toBe("wait");
  });
});
