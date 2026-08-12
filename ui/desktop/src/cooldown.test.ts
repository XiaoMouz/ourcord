import { describe, expect, it } from "vitest";
import { remainingCooldownSeconds } from "./cooldown";

describe("remainingCooldownSeconds", () => {
  it("counts down toward zero", () => {
    const startedAt = 1_000_000;
    const retryUntil = startedAt + 60_000;

    expect(remainingCooldownSeconds(retryUntil, startedAt)).toBe(60);
    expect(remainingCooldownSeconds(retryUntil, startedAt + 1_000)).toBe(59);
    expect(remainingCooldownSeconds(retryUntil, retryUntil)).toBe(0);
    expect(remainingCooldownSeconds(retryUntil, retryUntil + 1_000)).toBe(0);
  });
});
