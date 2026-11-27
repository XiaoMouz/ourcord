// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import { bridge } from "../bridge";
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

describe("ChatPane composer", () => {
  let container: HTMLDivElement;
  let root: Root;
  let pending: ReturnType<typeof deferred<unknown>>;
  const onError = vi.fn();

  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    pending = deferred<unknown>();
    vi.mocked(bridge).mockImplementation(async (method) => {
      if (method === "messages.list") return { messages: [] };
      if (method === "messages.send") return pending.promise;
      if (method === "files.upload") return { file_id: "file", filename: "example.txt" };
      throw new Error(`Unexpected method: ${method}`);
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<DialogProvider><ChatPane
        room={{ id: "room", lobby_id: "lobby", name: "general", type: "text", position: 0 }}
        myUserID="me" canModerate={false} getName={() => "Friend"} ensureNames={async () => {}}
        onError={onError} onCopy={() => {}} onNotice={() => {}}
      /></DialogProvider>);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function input() { return container.querySelector("input")!; }

  async function edit(value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
      input().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function submit() {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  }

  it("preserves text typed while an earlier message is in flight", async () => {
    await edit("First message");
    await act(async () => submit());
    await edit("Next message");
    await act(async () => pending.resolve({}));
    expect(input().value).toBe("Next message");
    expect(bridge).toHaveBeenCalledWith("messages.send", { room_id: "room", content: "First message" });
  });

  it("preserves an edited draft even when it matches the submitted text again", async () => {
    await edit("Same message");
    await act(async () => submit());
    await edit("");
    await edit("Same message");
    await act(async () => pending.resolve({}));
    expect(input().value).toBe("Same message");
  });

  it("clears the submitted draft when it has not been edited", async () => {
    await edit("  First message  ");
    await act(async () => submit());
    await act(async () => pending.resolve({}));
    expect(input().value).toBe("");
  });

  it("retains the current draft after a failed send", async () => {
    await edit("Retry me");
    await act(async () => submit());
    await act(async () => pending.reject(new Error("offline")));
    expect(input().value).toBe("Retry me");
    expect(onError).toHaveBeenCalledWith("Error: offline");
  });

  it("submits only once for repeated submit events before React renders", async () => {
    await edit("Only once");
    await act(async () => { submit(); submit(); });
    expect(vi.mocked(bridge).mock.calls.filter(([method]) => method === "messages.send")).toHaveLength(1);
    await act(async () => pending.resolve({}));
  });

  it("blocks text submission while the attachment picker is open and unlocks after cancellation", async () => {
    const selection = deferred<string | null>();
    vi.mocked(open).mockReturnValue(selection.promise);
    await edit("Attachment caption");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="上传附件"]')!.click());
    await act(async () => submit());
    expect(vi.mocked(bridge).mock.calls.filter(([method]) => method === "messages.send")).toHaveLength(0);
    await act(async () => selection.resolve(null));
    await act(async () => submit());
    expect(vi.mocked(bridge).mock.calls.filter(([method]) => method === "messages.send")).toHaveLength(1);
    await act(async () => pending.resolve({}));
  });
});
