// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge, type Snapshot } from "./bridge";
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
vi.mock("./components/ChatPane", () => ({ default: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

describe("App daemon snapshot races through voice controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  let serverSnapshot: Snapshot;
  let nextSnapshot: ReturnType<typeof deferred<Snapshot>> | undefined;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.clearAllMocks();
    serverSnapshot = {
      daemon_available: true,
      status: { vpn_active: true, path_summary: "direct", network_id: "voice-room", relay_used: false, path_flaps_total: 0 },
      voice: { joined: true, muted: true, deafened: false, local_speaking: false, transmitting: false },
    };
    nextSnapshot = undefined;
    vi.mocked(bridge).mockImplementation(async (method, args) => {
      if (method === "auth.status") return { authenticated: true };
      if (method === "lobbies.list") return { lobbies: [] };
      if (method === "presence.update") return {};
      if (method === "daemon.snapshot") {
        if (nextSnapshot) {
          const pending = nextSnapshot;
          nextSnapshot = undefined;
          return pending.promise;
        }
        return serverSnapshot;
      }
      if (method === "voice.mute") {
        serverSnapshot = { ...serverSnapshot, voice: { ...serverSnapshot.voice!, muted: Boolean(args?.muted) } };
        return {};
      }
      if (method === "voice.leave") {
        serverSnapshot = { ...serverSnapshot, voice: { ...serverSnapshot.voice!, joined: false } };
        return {};
      }
      if (method === "network.leave") return {};
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
  async function mount() {
    await act(async () => root.render(<DialogProvider><App /></DialogProvider>));
  }
  async function tick(ms = 1_000) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }
  const snapshots = () => vi.mocked(bridge).mock.calls.filter(([name]) => name === "daemon.snapshot").length;
  const control = (label: string) => container.querySelector<HTMLButtonElement>(`[data-tip="${label}"]`)!;
  async function pendingPoll() {
    const stale = serverSnapshot;
    const pending = nextSnapshot = deferred<Snapshot>();
    await tick();
    expect(snapshots()).toBe(2);
    return { stale, pending };
  }

  it("does not display muted after unmuting when a pre-action snapshot arrives last", async () => {
    await mount();
    const { stale, pending } = await pendingPoll();
    await act(async () => control("取消静音").click());
    expect(bridge).toHaveBeenCalledWith("voice.mute", { muted: false });
    expect(serverSnapshot.voice?.muted).toBe(false);
    expect(control("静音")).not.toBeNull();
    await act(async () => pending.resolve(stale));
    expect(control("静音")).not.toBeNull();
    expect(control("取消静音")).toBeNull();
  });

  it("does not restore a disconnected voice session from an old poll", async () => {
    await mount();
    const { stale, pending } = await pendingPoll();
    await act(async () => control("断开语音").click());
    expect(bridge).toHaveBeenCalledWith("voice.leave");
    expect(bridge).toHaveBeenCalledWith("network.leave");
    expect(control("断开语音").disabled).toBe(true);
    await act(async () => pending.resolve(stale));
    expect(control("断开语音").disabled).toBe(true);
  });

  it("does not accumulate background reads while a snapshot takes longer than the poll interval", async () => {
    await mount();
    const { pending } = await pendingPoll();
    await tick(3_000);
    expect(snapshots()).toBe(2);
    serverSnapshot = { ...serverSnapshot, voice: { ...serverSnapshot.voice!, muted: false } };
    await act(async () => pending.resolve(serverSnapshot));
    expect(control("静音")).not.toBeNull();
    await tick();
    expect(snapshots()).toBe(3);
  });

  it("allows an immediate action refresh while a background snapshot is pending", async () => {
    await mount();
    const { pending } = await pendingPoll();
    await act(async () => control("取消静音").click());
    expect(snapshots()).toBe(3);
    expect(control("静音")).not.toBeNull();
    await act(async () => pending.reject(new Error("obsolete daemon read")));
    expect(container.textContent).not.toContain("obsolete daemon read");
    expect(control("静音")).not.toBeNull();
  });

  it("recovers from a periodic snapshot failure without an unhandled rejection", async () => {
    await mount();
    const { pending } = await pendingPoll();
    await act(async () => pending.reject(new Error("temporary IPC failure")));
    serverSnapshot = { ...serverSnapshot, voice: { ...serverSnapshot.voice!, muted: false } };
    await tick();
    expect(control("静音")).not.toBeNull();
  });

  it("still reports failure of the refresh requested by a voice action", async () => {
    await mount();
    const pending = nextSnapshot = deferred<Snapshot>();
    await act(async () => control("取消静音").click());
    await act(async () => pending.reject(new Error("action refresh failed")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("action refresh failed");
  });
});
