// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge, type Message } from "../bridge";
import { DialogProvider } from "../dialog";
import ChatPane from "./ChatPane";

vi.mock("../bridge", () => ({ bridge: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

describe("ChatPane history after remote deletion", () => {
  let container: HTMLDivElement;
  let root: Root;
  let serverMessages: Message[];
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    serverMessages = Array.from({ length: 65 }, (_, index) => ({
      id: `message-${index.toString().padStart(2, "0")}`, room_id: "room", user_id: "other",
      content: `History entry ${index}`, created_at: 1792627200 + index * 6,
    }));
    vi.mocked(bridge).mockImplementation(async (method, args) => {
      if (method !== "messages.list") throw new Error(`Unexpected method: ${method}`);
      let messages = serverMessages;
      if (args?.before) {
        const boundary = serverMessages.find((message) => message.id === args.before);
        const timestamp = typeof args.before_created_at === "number" ? args.before_created_at : boundary?.created_at;
        if (timestamp === undefined) return { messages: [] };
        messages = messages.filter((message) => message.created_at < timestamp ||
          (message.created_at === timestamp && message.id < String(args.before)));
      }
      return { messages: messages.slice(-50) };
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("loads older messages using the saved position when another client deletes the visible boundary", async () => {
    await act(async () => root.render(<DialogProvider><ChatPane
      room={{ id: "room", lobby_id: "lobby", name: "chat", type: "text", position: 0 }}
      myUserID="me" canModerate={false} getName={(id) => id} ensureNames={async () => {}}
      onError={vi.fn()} onNotice={vi.fn()} onCopy={vi.fn()}
    /></DialogProvider>));
    expect(container.querySelectorAll("article")).toHaveLength(50);
    expect(bridge).toHaveBeenCalledWith("messages.list", { room_id: "room", limit: 50 });
    serverMessages = serverMessages.filter((message) => message.id !== "message-15");
    const older = [...container.querySelectorAll("button")].find((button) => button.textContent === "加载更早的消息");
    expect(older).toBeDefined();
    await act(async () => older!.click());
    expect(container.textContent).toContain("History entry 0");
    expect(bridge).toHaveBeenLastCalledWith("messages.list", {
      room_id: "room", before: "message-15", before_created_at: 1792627290, limit: 50,
    });
  });
});
