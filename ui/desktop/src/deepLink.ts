export type OurCordLink =
  | { kind: "auth"; code: string }
  | { kind: "invite"; lobbyID: string; code: string };

export function parseOurCordLink(raw: string): OurCordLink | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "ourcord:") return null;
  if (url.hostname === "auth") {
    const code = url.searchParams.get("code") ?? "";
    return /^[a-f0-9]{64}$/.test(code) ? { kind: "auth", code } : null;
  }
  if (url.hostname === "invite") {
    const lobbyID = url.searchParams.get("lobby_id") ?? "";
    const code = url.searchParams.get("code") ?? "";
    if (/^[a-f0-9]{32}$/.test(lobbyID) && /^[a-f0-9]{16}$/.test(code)) {
      return { kind: "invite", lobbyID, code };
    }
  }
  return null;
}
