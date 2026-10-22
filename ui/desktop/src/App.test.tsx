// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge } from "./bridge";
import { DialogProvider } from "./dialog";
import App from "./App";

vi.mock("./bridge", () => ({ bridge: vi.fn() }));
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: vi.fn(async () => null), onOpenUrl: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: vi.fn(async () => {}), unregister: vi.fn(async () => {}),
}));
vi.mock("./updater", () => ({
  useDesktopUpdater: () => ({ status: "idle" }),
  installDesktopUpdate: vi.fn(), retryDesktopUpdate: vi.fn(),
}));
vi.mock("./components/TitleBar", () => ({ default: () => null }));
vi.mock("./components/RoomPanel", () => ({ default: () => null }));
vi.mock("./components/VoiceStage", () => ({ default: () => null }));
vi.mock("./components/CallBar", () => ({ default: () => null }));
vi.mock("./components/ChatPane", () => ({ default: () => null }));
vi.mock("./components/SettingsModal", () => ({ default: () => null }));
vi.mock("./components/DiagnosticsModal", () => ({ default: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
const membership = (userID: string) => ({
  members: [{ user_id: userID, role: "member", online: true }],
});

describe("App lobby member requests", () => {
  let container: HTMLDivElement;
  let root: Root;
  let oldMembers: ReturnType<typeof deferred<unknown>>;
  let newMembers: ReturnType<typeof deferred<unknown>>;
  let presence: ReturnType<typeof deferred<unknown>> | undefined;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    oldMembers = deferred();
    newMembers = deferred();
    presence = undefined;
    vi.mocked(bridge).mockImplementation(async (method, args) => {
      if (method === "auth.status") return { authenticated: true };
      if (method === "lobbies.list") return {
        lobbies: ["Alpha", "Beta"].map((id) => ({
          lobby: { id, name: id }, member: { role: "member" }, rooms: [],
        })),
      };
      if (method === "daemon.snapshot") return { daemon_available: false };
      if (method === "presence.update") return presence?.promise ?? {};
      if (method === "lobbies.members") return args?.lobby_id === "Alpha" ? oldMembers.promise : newMembers.promise;
      if (method === "profiles.lookup") return {
        profiles: (args?.user_ids as string[]).map((id) => ({ id, display_name: id })),
      };
      throw new Error(`Unexpected bridge method: ${method}`);
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  async function mount() {
    await act(async () => root.render(<DialogProvider><App /></DialogProvider>));
  }
  async function switchLobby(name: string) {
    await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)!.click());
  }

  it("does not show Alpha members when its request finishes after switching to Beta", async () => {
    await mount();
    await switchLobby("Beta");
    await act(async () => newMembers.resolve(membership("Beta friend")));
    expect(container.textContent).toContain("Beta friend");
    await act(async () => oldMembers.resolve(membership("Alpha friend")));
    expect(container.textContent).toContain("Beta friend");
    expect(container.textContent).not.toContain("Alpha friend");
  });

  it("does not clear Beta members when an old Alpha request fails", async () => {
    await mount();
    await switchLobby("Beta");
    await act(async () => newMembers.resolve(membership("Beta friend")));
    await act(async () => oldMembers.reject(new Error("old request offline")));
    expect(container.textContent).toContain("Beta friend");
  });

  it("does not stop Beta's loading indicator when Alpha completes", async () => {
    await mount();
    await switchLobby("Beta");
    expect(container.querySelector("aside .skeleton")).not.toBeNull();
    await act(async () => oldMembers.resolve(membership("Alpha friend")));
    expect(container.querySelector("aside .skeleton")).not.toBeNull();
    await act(async () => newMembers.resolve(membership("Beta friend")));
    expect(container.textContent).toContain("Beta friend");
  });

  it("does not start an old lobby read after its pending presence heartbeat finishes", async () => {
    presence = deferred();
    await mount();
    await switchLobby("Beta");
    await act(async () => presence!.resolve({}));
    const requestedLobbies = vi.mocked(bridge).mock.calls
      .filter(([method]) => method === "lobbies.members").map(([, args]) => args?.lobby_id);
    expect(requestedLobbies).toEqual(["Beta"]);
  });

  it("ignores the first Alpha request after switching Alpha to Beta and back to Alpha", async () => {
    await mount();
    const firstAlpha = oldMembers;
    await switchLobby("Beta");
    oldMembers = deferred();
    await switchLobby("Alpha");
    await act(async () => oldMembers.resolve(membership("Current Alpha friend")));
    await act(async () => firstAlpha.resolve(membership("Outdated Alpha friend")));
    await act(async () => newMembers.resolve(membership("Beta friend")));
    expect(container.textContent).toContain("Current Alpha friend");
    expect(container.textContent).not.toContain("Outdated Alpha friend");
    expect(container.textContent).not.toContain("Beta friend");
  });

  it("keeps the newest poll result when an earlier poll resolves last", async () => {
    vi.useFakeTimers();
    try {
      await mount();
      const first = oldMembers;
      oldMembers = deferred();
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      await act(async () => oldMembers.resolve(membership("New poll friend")));
      await act(async () => first.resolve(membership("Old poll friend")));
      expect(container.textContent).toContain("New poll friend");
      expect(container.textContent).not.toContain("Old poll friend");
    } finally { vi.useRealTimers(); }
  });
});
