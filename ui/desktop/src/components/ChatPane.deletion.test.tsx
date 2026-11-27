// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge, type Message } from "../bridge";
import { DialogProvider } from "../dialog";
import ChatPane from "./ChatPane";

vi.mock("../bridge", () => ({ bridge: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function message(index: number): Message {
  return {
    id: `message-${index}`, room_id: "room", user_id: "me",
    content: `Message body ${index}`, created_at: 1792627200 + index,
  };
}

describe("ChatPane deletion with pending history reads", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onError = vi.fn<(message: string) => void>();
  let serverMessages: Message[];
  let pendingRead: ReturnType<typeof deferred<{ messages: Message[] }>> | undefined;
  let deleteError: string | undefined;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.clearAllMocks();
    onError = vi.fn();
    deleteError = undefined;
    pendingRead = undefined;
    serverMessages = [message(1)];
    vi.mocked(bridge).mockImplementation(async (method, args) => {
      if (method === "messages.list") {
        if (pendingRead) {
          const pending = pendingRead;
          pendingRead = undefined;
          return pending.promise;
        }
        return { messages: serverMessages.slice(-50) };
      }
      if (method === "messages.delete") {
        if (deleteError) throw new Error(deleteError);
        serverMessages = serverMessages.filter((entry) => entry.id !== args?.message_id);
        return { deleted: true };
      }
      throw new Error(`Unexpected method: ${method}`);
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

  async function render() {
    await act(async () => root.render(<DialogProvider><ChatPane
      room={{ id: "room", lobby_id: "lobby", name: "chat", type: "text", position: 0 }}
      myUserID="me" canModerate={false} getName={(id) => id} ensureNames={async () => {}}
      onError={onError} onNotice={vi.fn()} onCopy={vi.fn()}
    /></DialogProvider>));
  }

  function article(index: number) {
    return [...container.querySelectorAll("article")].find((entry) =>
      entry.querySelector("p")?.textContent === message(index).content);
  }

  async function remove(index: number, confirm = true) {
    const button = article(index)?.querySelector("button");
    expect(button).toBeDefined();
    await act(async () => button!.click());
    const action = [...container.querySelectorAll('[role="dialog"] button')].find((button) =>
      button.textContent === (confirm ? "删除" : "取消"));
    expect(action).toBeDefined();
    await act(async () => (action as HTMLButtonElement).click());
  }

  it("does not resurrect a confirmed deletion when a pre-deletion poll arrives late", async () => {
    await render();
    const stale = deferred<{ messages: Message[] }>();
    pendingRead = stale;
    await act(async () => vi.advanceTimersByTime(3000));
    await remove(1);
    expect(article(1)).toBeUndefined();
    expect(serverMessages).toEqual([]);
    await act(async () => stale.resolve({ messages: [message(1), message(2)] }));
    expect(article(1)).toBeUndefined();
    expect(article(2)).toBeDefined();
    serverMessages = [message(2), message(3)];
    await act(async () => vi.advanceTimersByTime(3000));
    expect(article(3)).toBeDefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it("filters a deleted message from an overlapping older-history page", async () => {
    serverMessages = Array.from({ length: 100 }, (_, i) => message(i));
    await render();
    const older = deferred<{ messages: Message[] }>();
    pendingRead = older;
    const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent === "加载更早的消息");
    await act(async () => button!.click());
    // Another moderator deletes the recent page, so a poll reveals entries
    // also contained in the still-pending older-history response.
    serverMessages = serverMessages.slice(0, 50);
    await act(async () => vi.advanceTimersByTime(3000));
    expect(article(25)).toBeDefined();
    await remove(25);
    expect(article(25)).toBeUndefined();
    await act(async () => older.resolve({ messages: Array.from({ length: 50 }, (_, i) => message(i)) }));
    expect(article(25)).toBeUndefined();
    expect(article(0)).toBeDefined();
    expect(article(49)).toBeDefined();
  });

  it("does not hide a message when deletion fails", async () => {
    await render();
    const stale = deferred<{ messages: Message[] }>();
    pendingRead = stale;
    await act(async () => vi.advanceTimersByTime(3000));
    deleteError = "service unavailable";
    await remove(1);
    expect(article(1)).toBeDefined();
    await act(async () => stale.resolve({ messages: [message(1), message(2)] }));
    expect(article(1)).toBeDefined();
    expect(article(2)).toBeDefined();
    expect(onError).toHaveBeenCalledWith("Error: service unavailable");
  });

  it("keeps a cancelled deletion visible and never sends the DELETE", async () => {
    await render();
    await remove(1, false);
    expect(article(1)).toBeDefined();
    expect(vi.mocked(bridge).mock.calls.some(([method]) => method === "messages.delete")).toBe(false);
  });
});
