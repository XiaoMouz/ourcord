import { describe, it, expect } from "vitest";
import { shortKey, relativeTime, pathTone, parseAttachments, formatBytes } from "./format";

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

describe("parseAttachments", () => {
  it("parses a JSON array of ids", () => {
    expect(parseAttachments('["a","b"]')).toEqual(["a", "b"]);
  });
  it("drops non-strings and empties", () => {
    expect(parseAttachments('["a",1,"",null,"b"]')).toEqual(["a", "b"]);
  });
  it("returns [] for undefined/malformed/non-array", () => {
    expect(parseAttachments(undefined)).toEqual([]);
    expect(parseAttachments("{bad")).toEqual([]);
    expect(parseAttachments('{"x":1}')).toEqual([]);
  });
});

describe("formatBytes", () => {
  it("renders sensible units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(30 * 1024 * 1024)).toBe("30 MB");
  });
  it("guards bad input", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(NaN)).toBe("—");
  });
});
