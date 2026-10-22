// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge, type Message } from "../bridge";
import { DialogProvider } from "../dialog";
import ChatPane from "./ChatPane";

vi.mock("../bridge", () => ({ bridge: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
type Page = { messages: Message[]; deletion_revision?: number };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const message = (i: number): Message => ({
  id: `message-${String(i).padStart(3, "0")}`, room_id: "room", user_id: "author",
  content: `Entry ${i}`, created_at: 1000 + i,
});

describe("remote message deletions across real chat views", () => {
  let views: { container: HTMLDivElement; root: Root }[];
  let messages: Message[];
  let revision: number;
  let versioned: boolean;
  let pending: ReturnType<typeof deferred<Page>> | undefined;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.clearAllMocks();
    views = [];
    messages = [message(1)];
    revision = 0;
    versioned = true;
    pending = undefined;
    vi.mocked(bridge).mockImplementation(async (method, args) => {
      if (method === "messages.list") {
        if (pending) { const read = pending; pending = undefined; return read.promise; }
        const eligible = args?.before ? messages.filter((m) =>
          m.created_at < Number(args.before_created_at) ||
          m.created_at === Number(args.before_created_at) && m.id < String(args.before)) : messages;
        return { messages: eligible.slice(-50), ...(versioned ? { deletion_revision: revision } : {}) };
      }
      if (method === "messages.delete") {
        messages = messages.filter((m) => m.id !== args?.message_id);
        revision++;
        return { deleted: true };
      }
      if (method === "messages.send") {
        const sent = { ...message(999), content: String(args?.content) };
        messages.push(sent);
        return sent;
      }
      throw new Error(`Unexpected bridge call ${method}`);
    });
  });
  afterEach(async () => {
    for (const view of views) {
      await act(async () => view.root.unmount());
      view.container.remove();
    }
    vi.useRealTimers();
  });
  async function mount(user = "reader") {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    views.push({ container, root });
    await act(async () => root.render(<DialogProvider><ChatPane
      room={{ id: "room", lobby_id: "lobby", name: "chat", type: "text", position: 0 }}
      myUserID={user} canModerate={false} getName={(id) => id} ensureNames={async () => {}}
      onError={vi.fn()} onCopy={vi.fn()} onNotice={vi.fn()}
    /></DialogProvider>));
    return container;
  }
  const article = (view: HTMLElement, i: number) => [...view.querySelectorAll("article")].find((el) => el.querySelector("p")?.textContent === `Entry ${i}`);
  const tick = () => act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  async function older(view: HTMLElement) {
    const button = [...view.querySelectorAll("button")].find((el) => el.textContent === "加载更早的消息");
    expect(button).toBeDefined();
    await act(async () => button!.click());
  }
  async function remove(view: HTMLElement, i: number) {
    await act(async () => article(view, i)!.querySelector("button")!.click());
    const confirm = [...view.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((el) => el.textContent === "删除");
    await act(async () => confirm!.click());
  }

  it("removes another client's deletion, including the final message in a room", async () => {
    const reader = await mount();
    const author = await mount("author");
    await remove(author, 1);
    expect(messages).toEqual([]);
    await tick();
    expect(reader.querySelectorAll("article")).toHaveLength(0);
    expect(reader.textContent).toContain("暂无消息");
  });

  it("invalidates previously loaded history even when the deleted row is outside the latest page", async () => {
    messages = Array.from({ length: 120 }, (_, i) => message(i));
    const reader = await mount();
    const author = await mount("author");
    for (const view of [reader, author]) { await older(view); await older(view); await older(view); }
    expect(reader.querySelectorAll("article")).toHaveLength(120);
    await remove(author, 0);
    await tick();
    expect(article(reader, 0)).toBeUndefined();
    expect(reader.querySelectorAll("article")).toHaveLength(50);
    await older(reader); await older(reader);
    expect(reader.querySelectorAll("article")).toHaveLength(119);
    expect(article(reader, 0)).toBeUndefined();
  });

  it("ignores old history arriving after a newer deletion revision", async () => {
    messages = Array.from({ length: 120 }, (_, i) => message(i));
    const reader = await mount();
    const author = await mount("author");
    await older(author);
    const stale: Page = { messages: messages.slice(20, 70), deletion_revision: 0 };
    const read = pending = deferred<Page>();
    await older(reader);
    await remove(author, 25);
    await tick();
    await act(async () => read.resolve(stale));
    expect(article(reader, 25)).toBeUndefined();
    expect(reader.querySelectorAll("article")).toHaveLength(50);
  });

  it("refreshes the latest page when an older-page request first observes a deletion", async () => {
    messages = Array.from({ length: 65 }, (_, i) => message(i));
    const reader = await mount();
    const author = await mount("author");
    await remove(author, 15);
    await older(reader);
    expect(article(reader, 15)).toBeUndefined();
    expect(reader.querySelectorAll("article")).toHaveLength(50);
    await older(reader);
    expect(reader.querySelectorAll("article")).toHaveLength(64);
  });

  it.each([undefined, 0])("does not restore a row from a late poll (revision: %s)", async (oldRevision) => {
    const reader = await mount();
    const author = await mount("author");
    const stale: Page = { messages: [...messages], deletion_revision: oldRevision };
    const read = pending = deferred<Page>();
    await tick();
    await remove(author, 1);
    await act(async () => {
      const input = reader.querySelector("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "New message");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => reader.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(reader.textContent).toContain("New message");
    await act(async () => read.resolve(stale));
    expect(article(reader, 1)).toBeUndefined();
    expect(reader.textContent).toContain("New message");
  });

  it("retains loaded history as new messages move the latest-page boundary", async () => {
    messages = Array.from({ length: 65 }, (_, i) => message(i));
    const reader = await mount();
    await older(reader);
    messages = [...messages, message(65), message(66)];
    await tick();
    expect(reader.querySelectorAll("article")).toHaveLength(67);
    expect(article(reader, 0)).toBeDefined();
  });

  it("invalidates legacy cached pages when a newly deployed service first supplies a revision", async () => {
    versioned = false;
    const reader = await mount();
    expect(article(reader, 1)).toBeDefined();
    // The message was deleted before the revision migration was installed.
    messages = [];
    versioned = true;
    await tick();
    expect(reader.querySelectorAll("article")).toHaveLength(0);
  });

  it("continues receiving messages if the service rolls back to an unversioned response", async () => {
    const reader = await mount();
    versioned = false;
    messages = [message(2)];
    await tick();
    expect(article(reader, 1)).toBeUndefined();
    expect(article(reader, 2)).toBeDefined();
    messages.push(message(3));
    await tick();
    expect(article(reader, 3)).toBeDefined();
    versioned = true;
    revision = 1;
    messages = [message(3)];
    await tick();
    expect(article(reader, 2)).toBeUndefined();
    expect(article(reader, 3)).toBeDefined();
  });

  it("ignores a pre-rollback versioned response after a fresh legacy page replaces it", async () => {
    const reader = await mount();
    const stale: Page = { messages: [...messages], deletion_revision: 0 };
    const read = pending = deferred<Page>();
    await tick();
    versioned = false;
    messages = [message(2)];
    await act(async () => {
      const input = reader.querySelector("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "New message");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => reader.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => read.resolve(stale));
    expect(article(reader, 1)).toBeUndefined();
    expect(article(reader, 2)).toBeDefined();
    expect(reader.textContent).toContain("New message");
  });
});
