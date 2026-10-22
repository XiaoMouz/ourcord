// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge, type LobbyEntry } from "./bridge";
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
vi.mock("./components/VoiceStage", () => ({ default: () => null }));
vi.mock("./components/CallBar", () => ({ default: () => null }));
vi.mock("./components/ChatPane", () => ({ default: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
const lobbyWithRooms = (...names: string[]): LobbyEntry => ({
  lobby: { id: "lobby", name: "Test lobby", owner_id: "me" },
  member: { role: "owner", joined_at: 1 },
  rooms: names.map((name, position) => ({
    id: `room-${position}`, lobby_id: "lobby", name, type: "text", position,
  })),
});

describe("App lobby snapshot races through room controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  let serverLobby: LobbyEntry;
  let nextList: ReturnType<typeof deferred<unknown>> | undefined;
  let lists: number;
  let roomWrites: number;
  let failSecondRoomWrite: boolean;
  let rejectSwap: boolean;
  let loseSwapResponse: boolean;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.clearAllMocks();
    serverLobby = lobbyWithRooms("Keep room", "Old room");
    nextList = undefined;
    lists = 0;
    roomWrites = 0;
    failSecondRoomWrite = false;
    rejectSwap = false;
    loseSwapResponse = false;
    vi.mocked(bridge).mockImplementation(async (method, args) => {
      if (method === "auth.status") return { authenticated: true };
      if (method === "daemon.snapshot") return { daemon_available: false };
      if (method === "presence.update") return {};
      if (method === "lobbies.members") return { members: [] };
      if (method === "lobbies.list") {
        lists++;
        if (nextList) {
          const pending = nextList;
          nextList = undefined;
          return pending.promise;
        }
        return { lobbies: [serverLobby] };
      }
      if (method === "rooms.delete") {
        serverLobby = { ...serverLobby, rooms: serverLobby.rooms.filter((room) => room.id !== args?.room_id) };
        return { deleted: true };
      }
      if (method === "rooms.create") {
        serverLobby = { ...serverLobby, rooms: [...serverLobby.rooms, {
          id: "new-room", lobby_id: "lobby", name: String(args?.name), type: "text", position: 2,
        }] };
        return {};
      }
      if (method === "rooms.update") {
        roomWrites++;
        if (failSecondRoomWrite && roomWrites === 2) throw new Error("second write failed");
        if (rejectSwap) throw new Error("room order changed");
        const source = serverLobby.rooms.find((room) => room.id === args?.room_id)!;
        serverLobby = { ...serverLobby, rooms: serverLobby.rooms.map((room) => {
          if (room.id === args?.room_id) return {
            ...room,
            ...(args.name !== undefined ? { name: String(args.name) } : {}),
            ...(args.position !== undefined ? { position: Number(args.position) } : {}),
          };
          if (room.id === args?.swap_with) return { ...room, position: source.position };
          return room;
        }) };
        if (loseSwapResponse) throw new Error("response lost");
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
  async function mount() {
    await act(async () => root.render(<DialogProvider><App /></DialogProvider>));
  }
  async function tick() {
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  }
  async function pendingPoll() {
    const stale = { lobbies: [serverLobby] };
    const pending = nextList = deferred();
    await tick();
    expect(lists).toBe(2);
    return { stale, pending };
  }
  async function button(text: string, within: ParentNode = container) {
    const target = [...within.querySelectorAll("button")].find((button) => button.textContent === text);
    expect(target, `missing button: ${text}`).toBeDefined();
    await act(async () => target!.click());
  }
  async function roomAction(name: string) {
    const row = [...container.querySelectorAll('[role="button"]')].find((element) => element.textContent?.includes("Old room"));
    expect(row).toBeDefined();
    await act(async () => row!.querySelector<HTMLButtonElement>('[aria-label="房间操作"]')!.click());
    await button(name);
  }
  async function enterName(value: string) {
    const input = container.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await button("确定", container.querySelector('[role="dialog"]')!);
  }


  it("moves a room atomically even when a second update would fail", async () => {
    failSecondRoomWrite = true;
    await mount();
    await roomAction("上移");
    expect(serverLobby.rooms.map((room) => room.position)).toEqual([1, 0]);
    expect(roomWrites).toBe(1);
    expect(bridge).toHaveBeenCalledWith("rooms.update", {
      room_id: "room-1", position: 0, expected_position: 1, swap_with: "room-0",
    });
    expect(container.textContent!.indexOf("Old room")).toBeLessThan(container.textContent!.indexOf("Keep room"));
  });

  it("reconciles a committed swap after a lost response without retrying it", async () => {
    await mount();
    loseSwapResponse = true;
    await roomAction("上移");
    expect(roomWrites).toBe(1);
    expect(lists).toBe(2);
    expect(serverLobby.rooms.map((room) => room.position)).toEqual([1, 0]);
    expect(container.textContent!.indexOf("Old room")).toBeLessThan(container.textContent!.indexOf("Keep room"));
    expect(container.textContent).toContain("response lost");
  });

  it("moves down past a same-type neighbor without moving a voice room", async () => {
    serverLobby.rooms.push(
      { id: "voice", lobby_id: "lobby", name: "Voice room", type: "voice", position: 2 },
      { id: "last", lobby_id: "lobby", name: "Last room", type: "text", position: 3 },
    );
    await mount();
    await roomAction("下移");
    expect(roomWrites).toBe(1);
    expect(serverLobby.rooms.map((room) => room.position)).toEqual([0, 3, 2, 1]);
    expect(bridge).toHaveBeenCalledWith("rooms.update", {
      room_id: "room-1", position: 3, expected_position: 1, swap_with: "last",
    });
  });

  it("refreshes a stale order immediately after a rejected swap", async () => {
    await mount();
    serverLobby = { ...serverLobby, rooms: serverLobby.rooms.map((room) => ({ ...room, position: 1 - room.position })) };
    rejectSwap = true;
    await roomAction("上移");
    expect(roomWrites).toBe(1);
    expect(lists).toBe(2);
    expect(container.textContent).toContain("room order changed");
    expect(container.textContent!.indexOf("Old room")).toBeLessThan(container.textContent!.indexOf("Keep room"));
  });

  it("does not resurrect a deleted room when a pre-delete poll arrives last", async () => {
    await mount();
    const { stale, pending } = await pendingPoll();
    await roomAction("删除房间");
    await button("删除", container.querySelector('[role="dialog"]')!);
    expect(container.textContent).not.toContain("Old room");
    expect(bridge).toHaveBeenCalledWith("rooms.delete", { room_id: "room-1" });
    await act(async () => pending.resolve(stale));
    expect(container.textContent).not.toContain("Old room");
    expect(container.textContent).toContain("Keep room");
  });

  it("does not hide a newly created room when an older poll arrives last", async () => {
    await mount();
    const { stale, pending } = await pendingPoll();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="新建文字房间"]')!.click());
    await enterName("New room");
    expect(container.textContent).toContain("New room");
    await act(async () => pending.resolve(stale));
    expect(container.textContent).toContain("New room");
  });

  it("does not undo a room rename with a stale lobby response", async () => {
    await mount();
    const { stale, pending } = await pendingPoll();
    await roomAction("重命名");
    await enterName("Renamed room");
    expect(container.textContent).toContain("Renamed room");
    await act(async () => pending.resolve(stale));
    expect(container.textContent).toContain("Renamed room");
    expect(container.textContent).not.toContain("Old room");
  });

  it("keeps the newest poll result when two polls complete out of order", async () => {
    await mount();
    const { stale, pending } = await pendingPoll();
    serverLobby = lobbyWithRooms("Keep room", "Remote rename");
    await tick();
    expect(container.textContent).toContain("Remote rename");
    await act(async () => pending.resolve(stale));
    expect(container.textContent).toContain("Remote rename");
    expect(container.textContent).not.toContain("Old room");
  });

  it("handles an obsolete poll rejection after room deletion without an unhandled error", async () => {
    await mount();
    const { pending } = await pendingPoll();
    await roomAction("删除房间");
    await button("删除", container.querySelector('[role="dialog"]')!);
    await act(async () => pending.reject(new Error("obsolete list failure")));
    expect(container.textContent).not.toContain("Old room");
    expect(container.textContent).not.toContain("obsolete list failure");
  });

  it("preserves the displayed rooms after a transient poll error and recovers next poll", async () => {
    await mount();
    const { pending } = await pendingPoll();
    await act(async () => pending.reject(new Error("transient list failure")));
    expect(container.textContent).toContain("Old room");
    serverLobby = lobbyWithRooms("Keep room", "Recovered room");
    await tick();
    expect(container.textContent).toContain("Recovered room");
  });
});
