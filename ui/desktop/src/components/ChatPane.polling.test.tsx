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
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

describe("ChatPane background polling under slow responses", () => {
  let container: HTMLDivElement;
  let root: Root;
  let nextRead: ReturnType<typeof deferred<{ messages: Message[] }>> | undefined;
  let messages: Message[];
  const onError = vi.fn();
  const reads = () => vi.mocked(bridge).mock.calls.filter(([method]) => method === "messages.list").length;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.clearAllMocks();
    messages = [];
    nextRead = undefined;
    vi.mocked(bridge).mockImplementation(async (method, args) => {
      if (method === "messages.list") {
        if (nextRead) {
          const pending = nextRead;
          nextRead = undefined;
          return pending.promise;
        }
        return { messages };
      }
      if (method === "messages.send") {
        messages = [{ id: "sent", room_id: "room", user_id: "me", content: String(args?.content), created_at: 1 }];
        return messages[0];
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
  async function mount() {
    await act(async () => root.render(<DialogProvider><ChatPane
      room={{ id: "room", lobby_id: "lobby", name: "chat", type: "text", position: 0 }}
      myUserID="me" canModerate={false} getName={(id) => id} ensureNames={async () => {}}
      onError={onError} onCopy={vi.fn()} onNotice={vi.fn()}
    /></DialogProvider>));
  }
  async function tick(ms = 3000) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  it("keeps one initial read in flight across four polling ticks", async () => {
    const pending = nextRead = deferred<{ messages: Message[] }>();
    await mount();
    await tick(12000);
    expect(reads()).toBe(1);
    await act(async () => pending.resolve({ messages: [] }));
    await tick();
    expect(reads()).toBe(2);
  });

  it("skips background ticks while a later poll is still pending", async () => {
    await mount();
    const pending = nextRead = deferred<{ messages: Message[] }>();
    await tick();
    await tick(9000);
    expect(reads()).toBe(2);
    await act(async () => pending.resolve({ messages: [] }));
    await tick();
    expect(reads()).toBe(3);
  });

  it("releases the background slot after an error and retries on the next tick", async () => {
    const pending = nextRead = deferred<{ messages: Message[] }>();
    await mount();
    await tick(6000);
    expect(reads()).toBe(1);
    await act(async () => pending.reject(new Error("HTTP deadline exceeded")));
    messages = [{ id: "new", room_id: "room", user_id: "other", content: "Recovered history", created_at: 1 }];
    await tick();
    expect(reads()).toBe(2);
    expect(container.textContent).toContain("Recovered history");
    expect(onError).not.toHaveBeenCalled();
  });

  it("refreshes immediately after sending while a background read is pending", async () => {
    await mount();
    const pending = nextRead = deferred<{ messages: Message[] }>();
    await tick();
    const input = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "New message");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(bridge).toHaveBeenCalledWith("messages.send", { room_id: "room", content: "New message" });
    expect(reads()).toBe(3);
    expect(container.querySelector("article")?.textContent).toContain("New message");
    await tick();
    expect(reads()).toBe(3);
    await act(async () => pending.resolve({ messages: [] }));
    expect(container.querySelector("article")?.textContent).toContain("New message");
    await tick();
    expect(reads()).toBe(4);
  });

  it("stops scheduling background reads after leaving the chat", async () => {
    await mount();
    const pending = nextRead = deferred<{ messages: Message[] }>();
    await tick();
    await act(async () => root.render(null));
    await act(async () => pending.resolve({ messages: [] }));
    await tick(12000);
    expect(reads()).toBe(2);
  });
});
