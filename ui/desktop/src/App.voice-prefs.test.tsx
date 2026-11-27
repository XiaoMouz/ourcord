// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge } from "./bridge";
import { loadVoicePrefs, saveVoicePrefs } from "./prefs";
import { DialogProvider } from "./dialog";
import App from "./App";

vi.mock("./bridge", () => ({ bridge: vi.fn() }));
vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: vi.fn(async () => null), onOpenUrl: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: vi.fn(async () => {}), unregister: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./updater", () => ({
  useDesktopUpdater: () => ({ status: "idle" }),
  installDesktopUpdate: vi.fn(), retryDesktopUpdate: vi.fn(),
}));
vi.mock("./components/TitleBar", () => ({ default: () => null }));
vi.mock("./components/VoiceStage", () => ({ default: () => null }));
vi.mock("./components/ChatPane", () => ({ default: () => null }));

describe("voice preferences committed through settings and reused on join", () => {
  let container: HTMLDivElement;
  let root: Root;
  let applyMode: () => Promise<void>;
  let snapshotFails: boolean;
  const saved = { mode: "push_to_talk" as const, threshold_dbfs: -45, hangover_ms: 300 };

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorage.clear();
    saveVoicePrefs(saved);
    applyMode = async () => {};
    snapshotFails = false;
    vi.mocked(bridge).mockImplementation(async (method) => {
      if (method === "auth.status") return { authenticated: true };
      if (method === "daemon.snapshot") {
        if (snapshotFails) throw new Error("snapshot unavailable");
        return { daemon_available: true };
      }
      if (method === "voice.devices") return { capture: [], playback: [] };
      if (method === "voice.input_mode") return applyMode();
      if (method === "voice.join_network" || method === "presence.update") return {};
      if (method === "lobbies.members") return { members: [] };
      if (method === "lobbies.list") return { lobbies: [{
        lobby: { id: "lobby", name: "Friends", owner_id: "me" },
        member: { role: "owner", joined_at: 1 },
        rooms: [{ id: "voice", lobby_id: "lobby", name: "Voice room", type: "voice", position: 0, vpn_namespace: "voice-network" }],
      }] };
      throw new Error(`Unexpected bridge method: ${method}`);
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    vi.useRealTimers();
  });

  async function editMode() {
    await act(async () => root.render(<DialogProvider><App /></DialogProvider>));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="设置"]')!.click());
    const select = container.querySelector<HTMLSelectElement>(".modal select")!;
    expect(select.value).toBe("push_to_talk");
    await act(async () => {
      select.value = "open_mic";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const apply = [...container.querySelectorAll<HTMLButtonElement>(".modal button")].find((button) => button.textContent === "应用")!;
    await act(async () => apply.click());
    expect(bridge).toHaveBeenCalledWith("voice.input_mode", { ...saved, mode: "open_mic" });
  }
  async function joinAfterClosingSettings() {
    await act(async () => container.querySelector<HTMLButtonElement>('.modal [aria-label="关闭"]')!.click());
    const room = [...container.querySelectorAll<HTMLElement>('[role="button"]')].find((row) => row.textContent?.includes("Voice room"))!;
    expect(room).toBeDefined();
    await act(async () => room.click());
    const calls = vi.mocked(bridge).mock.calls.filter(([method]) => method === "voice.join_network");
    expect(calls).toHaveLength(1);
    return calls[0][1];
  }

  it("does not enable open mic on the next join after applying it failed", async () => {
    applyMode = async () => { throw new Error("daemon unavailable"); };
    await editMode();
    expect(container.textContent).toContain("daemon unavailable");
    expect(await joinAfterClosingSettings()).toEqual({ ...saved, network_id: "voice-network" });
    expect(loadVoicePrefs()).toEqual(saved);
  });

  it("keeps the previous preference while the daemon has not acknowledged the change", async () => {
    let complete!: () => void;
    applyMode = () => new Promise<void>((resolve) => { complete = resolve; });
    await editMode();
    expect(loadVoicePrefs()).toEqual(saved);
    await act(async () => complete());
    expect(loadVoicePrefs()).toEqual({ ...saved, mode: "open_mic" });
    expect(await joinAfterClosingSettings()).toEqual({ ...saved, mode: "open_mic", network_id: "voice-network" });
  });

  it("retains an acknowledged setting even if the following snapshot refresh fails", async () => {
    applyMode = async () => { snapshotFails = true; };
    await editMode();
    expect(container.textContent).toContain("snapshot unavailable");
    snapshotFails = false;
    expect(await joinAfterClosingSettings()).toEqual({ ...saved, mode: "open_mic", network_id: "voice-network" });
  });
});
