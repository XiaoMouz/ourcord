// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge, type FileRecord, type Message } from "../bridge";
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
  const listFiles = vi.fn<() => Promise<{ files: FileRecord[] }>>();
  const onError = vi.fn();
  const reads = () => vi.mocked(bridge).mock.calls.filter(([method]) => method === "messages.list").length;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.clearAllMocks();
    listFiles.mockReset();
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
      if (method === "files.list") return listFiles();
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

  const attachment: FileRecord = { id: "file", room_id: "room", uploader_id: "me", filename: "notes.txt", size_bytes: 10, mime_type: "text/plain", created_at: 1 };
  const withAttachment: Message = { id: "msg", room_id: "room", user_id: "me", content: "notes", attachments: '["file"]', created_at: 1 };

  it("keeps a slow attachment lookup across successful message polls", async () => {
    messages = [withAttachment];
    const lookup = deferred<{ files: FileRecord[] }>();
    listFiles.mockReturnValue(lookup.promise);
    await mount();
    await tick(12000);
    expect(reads()).toBeGreaterThan(1);
    expect(listFiles).toHaveBeenCalledTimes(1);
    await act(async () => lookup.resolve({ files: [attachment] }));
    expect(container.textContent).toContain("notes.txt");
    await tick();
    expect(listFiles).toHaveBeenCalledTimes(1);
  });

  it("backs off repeated attachment failures and recovers while messages stay healthy", async () => {
    messages = [withAttachment];
    listFiles.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ files: [] }).mockResolvedValue({ files: [attachment] });
    await mount();
    await tick();
    expect(listFiles).toHaveBeenCalledTimes(2);
    await tick();
    expect(listFiles).toHaveBeenCalledTimes(2);
    await tick();
    expect(listFiles).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("notes.txt");
  });

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

  it("backs off consecutive failures, caps the interval and restores normal polling on recovery", async () => {
    let offline = true;
    vi.mocked(bridge).mockImplementation(async () => {
      if (offline) throw new Error("service unavailable");
      return { messages: [] };
    });
    await mount();
    let expectedReads = 1;
    for (const delay of [3000, 6000, 12000, 24000, 48000, 60000, 60000]) {
      await tick(delay - 1);
      expect(reads()).toBe(expectedReads);
      await tick(1);
      expect(reads()).toBe(++expectedReads);
    }
    offline = false;
    await tick(60000);
    expect(reads()).toBe(++expectedReads);
    await tick(3000);
    expect(reads()).toBe(++expectedReads);
    await act(async () => root.render(null));
    await tick(60000);
    expect(reads()).toBe(expectedReads);
  });

  it("does not schedule another poll when an in-flight read settles after unmount", async () => {
    const pending = nextRead = deferred<{ messages: Message[] }>();
    await mount();
    await act(async () => root.render(null));
    await act(async () => pending.reject(new Error("service unavailable")));
    await tick(60000);
    expect(reads()).toBe(1);
  });

  it("refreshes immediately after sending while a background read is pending", async () => {
    await mount();
    const pending = nextRead = deferred<{ messages: Message[] }>();
    await tick();
    const input = container.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "New message");
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
