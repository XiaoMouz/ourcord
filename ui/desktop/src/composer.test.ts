import { describe, expect, it } from "vitest";
import { shouldSendMessage } from "./composer";

const enter = { key: "Enter", shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, keyCode: 13 };

describe("shouldSendMessage", () => {
  it("sends only a plain Enter", () => {
    expect(shouldSendMessage(enter)).toBe(true);
    expect(shouldSendMessage({ ...enter, key: "a", keyCode: 65 })).toBe(false);
  });

  it.each(["shiftKey", "ctrlKey", "altKey", "metaKey"] as const)("preserves modified Enter with %s", (modifier) => {
    expect(shouldSendMessage({ ...enter, [modifier]: true })).toBe(false);
  });

  it("does not submit an IME candidate confirmation", () => {
    expect(shouldSendMessage({ ...enter, isComposing: true })).toBe(false);
    expect(shouldSendMessage({ ...enter, keyCode: 229 })).toBe(false);
  });
});
