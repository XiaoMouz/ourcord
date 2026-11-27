// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge, type LobbyEntry, type Message, type Snapshot } from "./bridge";
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

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

const lobby: LobbyEntry = {
  lobby: { id: "L1", name: "Friends", owner_id: "me" },
  member: { role: "owner", joined_at: 1 },
  rooms: [{ id: "chat", lobby_id: "L1", name: "Chat", type: "text", position: 0 }, ...["A", "B"].map((id, position) => ({
    id, lobby_id: "L1", name: `Voice ${id}`, type: "voice", position, vpn_namespace: `network-${id}`,
  }))],
};

describe("App presence writes through voice controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  let snapshot: Snapshot;
  let serverPresence: string;
  let messages: Message[];
  let nextSend: ReturnType<typeof deferred> | undefined;
  let nextWrite: ReturnType<typeof deferred> | undefined;
  let writes: string[];
  let activeWrites: number;
  let maxActiveWrites: number;

  function voice(room: string) {
    snapshot = {
      daemon_available: true,
      status: { vpn_active: true, network_id: room ? `network-${room}` : "", path_summary: "direct", relay_used: false, path_flaps_total: 0 },
      voice: { joined: !!room, muted: false, deafened: false, transmitting: false, local_speaking: false },
    };
  }

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.clearAllMocks();
    voice("");
    serverPresence = "";
    messages = [];
    nextSend = undefined;
    nextWrite = undefined;
    writes = [];
    activeWrites = maxActiveWrites = 0;
    vi.mocked(bridge).mockImplementation(async (method, args) => {
      if (method === "auth.status") return { authenticated: true };
      if (method === "lobbies.list") return { lobbies: [lobby] };
      if (method === "lobbies.members") return { members: [] };
      if (method === "messages.list") return { messages: messages.filter((message) => message.room_id === args?.room_id) };
      if (method === "messages.send") {
        await nextSend?.promise;
        messages.push({ id: "sent", room_id: String(args?.room_id), content: String(args?.content), user_id: "me", created_at: 1 });
        return {};
      }
      if (method === "daemon.snapshot") return snapshot;
      if (method === "presence.update") {
        const room = String(args?.voice_room_id ?? "");
        const pending = nextWrite;
        nextWrite = undefined;
        writes.push(room);
        activeWrites++;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        try {
          await pending?.promise;
          // The service's presence UPSERT stores the state of the last write
          // to execute. Hold the old write until after the voice action.
          serverPresence = room;
          return {};
        } finally { activeWrites--; }
      }
      if (method === "voice.join_network") {
        voice(String(args?.network_id).replace("network-", ""));
        return {};
      }
      if (method === "voice.leave") { voice(""); return {}; }
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
  async function tick(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }
  async function join(room: string) {
    const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')]
      .find((element) => element.textContent?.includes(`Voice ${room}`));
    expect(row).toBeDefined();
    await act(async () => row!.click());
  }
  async function leave() {
    const button = container.querySelector<HTMLButtonElement>('button[data-tip="断开语音"]');
    expect(button?.disabled).toBe(false);
    await act(async () => button!.click());
  }

  it("sends side chat to the active voice room without reconnecting", async () => {
    voice("B");
    await mount();
    const input = container.querySelector<HTMLTextAreaElement>(".channel-chat textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "voice room note");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>(".channel-chat [type=submit]")!.click());
    expect(bridge).toHaveBeenCalledWith("messages.send", { room_id: "B", content: "voice room note" });
    expect(vi.mocked(bridge).mock.calls.some(([method]) => method === "voice.join_network")).toBe(false);
  });

  it("browses text during a call and returns to the active room without reconnecting", async () => {
    voice("A");
    await mount();
    await join("A");
    const textRoom = container.querySelector<HTMLElement>('[title="Chat"]')!;
    await act(async () => textRoom.click());
    expect(container.querySelector(".room-heading h1")?.textContent).toBe("Chat");
    const returnToCall = container.querySelector<HTMLButtonElement>('button[title="返回 Voice A"]')!;
    expect(returnToCall.textContent).toBe("Voice A");
    await act(async () => returnToCall.click());
    expect(container.querySelector(".room-heading h1")?.textContent).toBe("Voice A");
    expect(container.querySelector('[aria-label="语音频道聊天"]')).not.toBeNull();
    expect(vi.mocked(bridge).mock.calls.filter(([method]) => method === "voice.join_network")).toHaveLength(0);
  });

  it.each([true, false])("refreshes acknowledged sends only in the visible room (returned=%s)", async (returned) => {
    voice("A");
    await mount();
    const pending = nextSend = deferred();
    const input = container.querySelector<HTMLTextAreaElement>(".channel-chat textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "Voice room note");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector<HTMLButtonElement>(".channel-chat [type=submit]")!.click());
    await act(async () => container.querySelector<HTMLElement>('[title="Chat"]')!.click());
    if (returned) await act(async () => container.querySelector<HTMLButtonElement>('button[title="返回 Voice A"]')!.click());
    const readCount = () => vi.mocked(bridge).mock.calls.filter(([method, args]) => method === "messages.list" && args?.room_id === "A").length;
    const previous = readCount();
    await act(async () => pending.resolve());
    expect(readCount() - previous).toBe(returned ? 1 : 0);
    if (returned) expect(container.querySelector(".channel-chat article")?.textContent).toContain("Voice room note");
    else expect(container.querySelector("article")).toBeNull();
    expect(bridge).not.toHaveBeenCalledWith("voice.join_network", expect.anything());
  });

  it.each([["", "A"], ["A", "B"], ["A", ""]])(
    "does not let a delayed %j heartbeat overwrite the action's %j presence",
    async (initial, target) => {
      voice(initial);
      await mount();
      expect(serverPresence).toBe(initial);
      const pending = nextWrite = deferred();
      await tick(30_000);
      expect(activeWrites).toBe(1);
      if (target) await join(target);
      else await leave();
      await act(async () => pending.resolve());
      expect(serverPresence).toBe(target);
      expect(writes.at(-1)).toBe(target);
      expect(maxActiveWrites).toBe(1);
    },
  );

  it("reconciles a joined startup snapshot after the initial empty presence finishes", async () => {
    voice("A");
    const pending = nextWrite = deferred();
    await mount();
    await act(async () => pending.resolve());
    expect(serverPresence).toBe("A");
    expect(maxActiveWrites).toBe(1);
  });

  it("continues with the newest presence after an older heartbeat fails", async () => {
    await mount();
    const pending = nextWrite = deferred();
    await tick(30_000);
    await join("A");
    await act(async () => pending.reject(new Error("temporary presence outage")));
    expect(serverPresence).toBe("A");
    expect(container.textContent).not.toContain("temporary presence outage");
    await tick(30_000);
    expect(serverPresence).toBe("A");
    expect(maxActiveWrites).toBe(1);
  });

  it("keeps regular heartbeats after the previous write settles", async () => {
    voice("A");
    await mount();
    const initial = writes.length;
    await tick(60_000);
    expect(writes.length).toBe(initial + 2);
    expect(serverPresence).toBe("A");
    expect(maxActiveWrites).toBe(1);
  });

  it("skips intermediate queued voice states while a heartbeat is in flight", async () => {
    await mount();
    writes = [];
    const pending = nextWrite = deferred();
    await tick(30_000);
    voice("A");
    await tick(1_000);
    voice("B");
    await tick(1_000);
    expect(writes).toEqual([""]);
    await act(async () => pending.resolve());
    expect(writes).toEqual(["", "B"]);
    expect(serverPresence).toBe("B");
  });

  it("does not send queued presence after the app unmounts", async () => {
    await mount();
    writes = [];
    const pending = nextWrite = deferred();
    await tick(30_000);
    voice("A");
    await tick(1_000);
    await act(async () => root.unmount());
    await act(async () => pending.resolve());
    expect(writes).toEqual([""]);
  });
});
