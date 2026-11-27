// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge } from "./bridge";
import { DialogProvider } from "./dialog";
import App from "./App";

vi.mock("./bridge", () => ({ bridge: vi.fn() }));
vi.mock("@tauri-apps/plugin-deep-link", () => ({ getCurrent: vi.fn(async () => null), onOpenUrl: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({ register: vi.fn(async () => {}), unregister: vi.fn(async () => {}) }));
vi.mock("./updater", () => ({ useDesktopUpdater: () => ({ status: "idle" }), installDesktopUpdate: vi.fn(), retryDesktopUpdate: vi.fn() }));
vi.mock("./components/TitleBar", () => ({ default: () => null }));
vi.mock("./components/VoiceStage", () => ({ default: () => null }));
vi.mock("./components/CallBar", () => ({ default: () => null }));
vi.mock("./components/ChatPane", () => ({ default: () => null }));

const ids = Array.from({ length: 93 }, (_, i) => (i + 1).toString(16).padStart(32, "0"));
const name = (id: string) => `Member ${Number.parseInt(id, 16)}`;

describe("member profile lookups through App polling", () => {
  let container: HTMLDivElement;
  let root: Root;
  let requests: string[][];
  let failed: number;
  let tailUnavailable: boolean;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.clearAllMocks();
    requests = [];
    failed = 0;
    tailUnavailable = false;
    vi.mocked(bridge).mockImplementation(async (method, args) => {
      if (method === "auth.status") return { authenticated: true };
      if (method === "daemon.snapshot") return { daemon_available: false };
      if (method === "presence.update") return {};
      if (method === "lobbies.list") return { lobbies: [{
        lobby: { id: "lobby", name: "Friends", owner_id: ids[0] }, member: { role: "owner", joined_at: 1 },
        rooms: [{ id: "room", lobby_id: "lobby", name: "Chat", type: "text", position: 0 }],
      }] };
      if (method === "lobbies.members") return { members: ids.map((user_id) => ({ user_id, role: "member", joined_at: 1, online: true })) };
      if (method === "profiles.lookup") {
        const batch = args!.user_ids as string[];
        requests.push(batch);
        if (batch.length > 90) { failed++; throw new Error("user_ids must contain at most 90 user ids"); }
        if (tailUnavailable && batch.includes(ids[90])) { failed++; throw new Error("temporary failure"); }
        return { profiles: batch.map((id) => ({ id, display_name: name(id) })) };
      }
      throw new Error(`Unexpected bridge method: ${method}`);
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
  const memberNames = () => [...container.querySelectorAll("aside li.list-row > span.truncate")].map((row) => row.textContent);
  const mount = () => act(async () => root.render(<DialogProvider><App /></DialogProvider>));
  const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

  it("resolves every member once instead of repeating oversized requests each poll", async () => {
    await mount();
    await tick();
    await tick();
    expect(failed).toBe(0);
    expect(memberNames()).toEqual(ids.map(name));
    expect(requests.map((batch) => batch.length)).toEqual([90, 3]);
  });

  it("retains completed batches after a later failure and retries only unresolved names", async () => {
    tailUnavailable = true;
    await mount();
    expect(memberNames().slice(0, 90)).toEqual(ids.slice(0, 90).map(name));
    expect(requests.map((batch) => batch.length)).toEqual([90, 3]);
    tailUnavailable = false;
    await tick();
    expect(memberNames()).toEqual(ids.map(name));
    expect(requests.map((batch) => batch.length)).toEqual([90, 3, 3]);
    await tick();
    expect(requests).toHaveLength(3);
  });
});
