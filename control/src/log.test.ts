import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { log, newRequestId } from "./log";

describe("log", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("emits valid JSON with ts, level, event fields", () => {
    log({ event: "test.event", foo: "bar" });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe("test.event");
    expect(parsed.level).toBe("info");
    expect(parsed.foo).toBe("bar");
    expect(typeof parsed.ts).toBe("string");
    expect(() => new Date(parsed.ts).toISOString()).not.toThrow();
  });

  it("routes errors to console.error", () => {
    log({ event: "boom", level: "error", error: "nope" });
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(errSpy.mock.calls[0][0] as string);
    expect(parsed.level).toBe("error");
    expect(parsed.error).toBe("nope");
  });

  it("newRequestId returns a 36-char uuid", () => {
    const id = newRequestId();
    expect(id).toHaveLength(36);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
