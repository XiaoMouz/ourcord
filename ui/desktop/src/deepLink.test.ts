import { describe, expect, it } from "vitest";
import { parseOurCordLink } from "./deepLink";

describe("parseOurCordLink", () => {
  it("accepts a PKCE authorization code", () => {
    expect(parseOurCordLink(`ourcord://auth?code=${"a".repeat(64)}`)).toEqual({ kind: "auth", code: "a".repeat(64) });
  });
  it("accepts a bounded invite", () => {
    expect(parseOurCordLink(`ourcord://invite?lobby_id=${"b".repeat(32)}&code=${"c".repeat(16)}`)).toEqual({ kind: "invite", lobbyID: "b".repeat(32), code: "c".repeat(16) });
  });
  it("rejects foreign schemes and malformed values", () => {
    expect(parseOurCordLink("https://evil.example/?code=x")).toBeNull();
    expect(parseOurCordLink("ourcord://auth?code=../../token")).toBeNull();
    expect(parseOurCordLink("not a url")).toBeNull();
  });
});
