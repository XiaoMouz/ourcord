import { describe, it, expect } from "vitest";
import { mergeMessages, senderIDs } from "./messages";
import type { Message } from "./bridge";

function msg(id: string, created_at: number, user_id = "u1"): Message {
  return { id, room_id: "r1", user_id, content: `msg ${id}`, created_at };
}

describe("mergeMessages", () => {
  it("unions pages chronologically and dedupes by id", () => {
    const existing = [msg("a", 1), msg("b", 2)];
    const incoming = [msg("b", 2), msg("c", 3)];
    expect(mergeMessages(existing, incoming).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps existing object identity on collision", () => {
    const original = msg("a", 1);
    const merged = mergeMessages([original], [msg("a", 1)]);
    expect(merged[0]).toBe(original);
  });

  it("orders same-timestamp messages by id for stability", () => {
    const merged = mergeMessages([msg("z", 5)], [msg("a", 5)]);
    expect(merged.map((m) => m.id)).toEqual(["a", "z"]);
  });

  it("interleaves an older page loaded after a newer one", () => {
    const newer = [msg("c", 30), msg("d", 40)];
    const older = [msg("a", 10), msg("b", 20)];
    expect(mergeMessages(newer, older).map((m) => m.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("senderIDs", () => {
  it("collects distinct sender ids in first-seen order", () => {
    const messages = [msg("a", 1, "u1"), msg("b", 2, "u2"), msg("c", 3, "u1")];
    expect(senderIDs(messages)).toEqual(["u1", "u2"]);
  });
});
