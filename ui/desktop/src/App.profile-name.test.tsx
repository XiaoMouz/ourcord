// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge, type Profile } from "./bridge";
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
vi.mock("./components/CallBar", () => ({ default: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("display name updates through real settings controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  let serverName: string;
  let saveFails: boolean;
  let includeProfile: boolean;
  let pendingNames: ReturnType<typeof deferred<{ profiles: Profile[] }>> | undefined;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.clearAllMocks();
    serverName = "Old name";
    saveFails = false;
    includeProfile = true;
    pendingNames = undefined;
    vi.mocked(bridge).mockImplementation(async (method, args) => {
      if (method === "auth.status") return {
        authenticated: true, ...(includeProfile ? { profile: { user: { id: "me", display_name: serverName } } } : {}),
      };
      if (method === "daemon.snapshot") return { daemon_available: false };
      if (method === "presence.update") return {};
      if (method === "voice.devices") return { capture: [], playback: [] };
      if (method === "lobbies.list") return { lobbies: [{
        lobby: { id: "lobby", name: "Friends", owner_id: "me" },
        member: { role: "owner", joined_at: 1 },
        rooms: [{ id: "room", lobby_id: "lobby", name: "Chat room", type: "text", position: 0 }],
      }] };
      if (method === "lobbies.members") return { members: ["me", "other"].map((user_id) => ({
        lobby_id: "lobby", user_id, role: "member", joined_at: 1, online: true,
      })) };
      if (method === "messages.list") return { messages: ["me", "other"].map((user_id) => ({
        id: `message-${user_id}`, room_id: "room", user_id, content: `Body from ${user_id}`, created_at: 1,
      })) };
      if (method === "profiles.lookup") {
        if (pendingNames) return pendingNames.promise;
        return { profiles: (args!.user_ids as string[]).map((id) => ({
          id, display_name: id === "me" ? serverName : "Other member",
        })) };
      }
      if (method === "profile.update") {
        if (saveFails) throw new Error("name save failed");
        if (String(args?.display_name).length > 48) throw new Error("display_name too long (max 48)");
        serverName = String(args?.display_name);
        return {};
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

  async function mountChat() {
    await act(async () => root.render(<DialogProvider><App /></DialogProvider>));
    const room = [...container.querySelectorAll<HTMLElement>('[role="button"]')].find((row) => row.textContent?.includes("Chat room"));
    expect(room).toBeDefined();
    await act(async () => room!.click());
  }
  const sender = (userID: string) => [...container.querySelectorAll("article")].find((row) =>
    row.querySelector("p")?.textContent === `Body from ${userID}`)?.querySelector("strong")?.textContent;
  const memberNames = () => [...container.querySelectorAll("aside li.list-row > span")].map((row) => row.textContent);
  const lookups = () => vi.mocked(bridge).mock.calls.filter(([method]) => method === "profiles.lookup").length;

  async function editName(value: string) {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="设置"]')!.click());
    const input = container.querySelector<HTMLInputElement>(".modal input.input")!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...container.querySelectorAll<HTMLButtonElement>(".modal button")].find((button) => button.textContent === "保存");
    return { input, save: save! };
  }
  async function saveName() {
    const { save } = await editName("New name");
    expect(save?.disabled).toBe(false);
    await act(async () => save!.click());
  }

  it.each([49, 64])("does not send an overlong %i-unit name from settings", async (length) => {
    await mountChat();
    const { input, save } = await editName("n".repeat(length));
    await act(async () => save.click());
    expect(bridge).not.toHaveBeenCalledWith("profile.update", expect.anything());
    expect(input.maxLength).toBe(48);
    expect(save.disabled).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(container.textContent).toContain("显示名过长");
  });

  it.each(["n".repeat(48), "名".repeat(48), "😀".repeat(24)])("saves a boundary-length name: %s", async (value) => {
    await mountChat();
    const { save } = await editName(value);
    expect(save.disabled).toBe(false);
    await act(async () => save.click());
    expect(serverName).toBe(value);
    expect(sender("me")).toBe(value);
  });

  it("preserves an existing overlong name until the user corrects it", async () => {
    serverName = "old".repeat(20);
    await mountChat();
    const { input, save } = await editName(serverName);
    expect(input.value).toBe(serverName);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(save.disabled).toBe(true);
    const corrected = await editName("shorter name");
    await act(async () => corrected.save.click());
    expect(serverName).toBe("shorter name");
    expect(container.textContent).not.toContain("显示名过长");
  });

  it("updates cached self names in messages and members after saving without another profile lookup", async () => {
    await mountChat();
    expect(sender("me")).toBe("Old name");
    expect(memberNames()).toContain("Old name");
    const initialLookups = lookups();
    await saveName();
    expect(bridge).toHaveBeenCalledWith("profile.update", { display_name: "New name" });
    expect(sender("me")).toBe("New name");
    expect(memberNames()).toContain("New name");
    expect(memberNames()).not.toContain("Old name");
    expect(sender("other")).toBe("Other member");
    expect(lookups()).toBe(initialLookups);
  });

  it("does not revert a saved self name when an older profile lookup completes later", async () => {
    const pending = pendingNames = deferred<{ profiles: Profile[] }>();
    await mountChat();
    await saveName();
    await act(async () => pending.resolve({ profiles: [
      { id: "me", display_name: "Old name" }, { id: "other", display_name: "Other member" },
    ] }));
    expect(sender("me")).toBe("New name");
    expect(memberNames()).toContain("New name");
    expect(sender("other")).toBe("Other member");
  });

  it("keeps the existing name when saving fails", async () => {
    await mountChat();
    saveFails = true;
    await saveName();
    expect(sender("me")).toBe("Old name");
    expect(memberNames()).toContain("Old name");
    expect(container.textContent).toContain("name save failed");
  });

  it("retains lookup names when auth.status provides no account profile", async () => {
    includeProfile = false;
    await mountChat();
    expect(sender("me")).toBe("Old name");
    expect(sender("other")).toBe("Other member");
  });
});
