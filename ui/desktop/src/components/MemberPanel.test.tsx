import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Member } from "../bridge";
import MemberPanel from "./MemberPanel";

describe("MemberPanel", () => {
  it("renders lobby members in a dedicated panel", () => {
    const members = [
      { user_id: "owner", role: "owner", online: true },
      { user_id: "member", role: "member", online: false },
    ] as Member[];
    const html = renderToStaticMarkup(
      <MemberPanel members={members} loading={false} getName={(id) => id === "owner" ? "Alice" : "Bob"} onCopy={() => undefined} />,
    );

    expect(html).toContain("成员 · 2");
    expect(html).toContain("Alice");
    expect(html).toContain("Bob");
    expect(html).toContain("所有者");
    expect(html).toContain("1 人在线");
    expect(html).toContain("在线 — 1");
    expect(html).toContain("离线 — 1");
    expect(html).toContain("avatar-online");
    expect(html).toContain("avatar-offline");
    expect(html).toContain('class="list');
  });
});
