// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bridge: vi.fn(),
  check: vi.fn(),
  relaunch: vi.fn(),
  listen: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("./bridge", () => ({ bridge: mocks.bridge }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => true) }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("@tauri-apps/api/window", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/window")>();
  return {
    ...actual,
    getCurrentWindow: () => ({
      // Exercise Tauri's actual dispatch, including its automatic destroy
      // when a close event returns without preventDefault().
      onCloseRequested: actual.Window.prototype.onCloseRequested,
      listen: mocks.listen,
      destroy: mocks.destroy,
    }),
  };
});

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

describe("desktop close lifecycle", () => {
  let root: Root;
  let container: HTMLDivElement;
  let dispatch: () => Promise<void>;
  let updater: typeof import("./updater");

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    mocks.listen.mockImplementation(async (_event, handler) => {
      dispatch = () => handler({ event: "tauri://close-requested", id: 1, payload: null });
      return () => {};
    });
    mocks.bridge.mockResolvedValue(undefined);
    mocks.destroy.mockResolvedValue(undefined);
    mocks.relaunch.mockResolvedValue(undefined);
    updater = await import("./updater");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    function Consumer() { updater.useDesktopUpdater(); return null; }
    await act(async () => root.render(createElement(Consumer)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("waits for session retirement despite repeated close requests", async () => {
    const leave = deferred();
    mocks.bridge.mockImplementation((method) => method === "network.leave" ? leave.promise : Promise.resolve());
    const closing = dispatch();
    await dispatch();
    await dispatch();
    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(mocks.bridge.mock.calls.map(([method]) => method)).toEqual(["network.leave", "presence.leave"]);
    leave.resolve();
    await closing;
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it("retains the bounded shutdown timeout when the daemon does not respond", async () => {
    mocks.bridge.mockReturnValue(new Promise(() => {}));
    const closing = dispatch();
    await dispatch();
    expect(mocks.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    await closing;
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure"])("does not destroy during download or installation (%s)", async (outcome) => {
    const download = deferred();
    const install = deferred();
    const available = { version: "next", download: vi.fn(() => download.promise), install: vi.fn(() => install.promise) };
    mocks.check.mockResolvedValue(available);
    let checking!: Promise<void>;
    await act(async () => { checking = updater.checkForDesktopUpdate(); });
    expect(available.download).toHaveBeenCalledOnce();
    const closing = dispatch();
    await act(async () => { await dispatch(); });
    expect(mocks.destroy).not.toHaveBeenCalled();
    await act(async () => { download.resolve(); await checking; });
    expect(available.install).toHaveBeenCalledOnce();
    await dispatch();
    expect(mocks.destroy).not.toHaveBeenCalled();
    await act(async () => {
      if (outcome === "success") install.resolve();
      else install.reject(new Error("install failed"));
      await closing;
    });
    expect(mocks.relaunch).toHaveBeenCalledTimes(outcome === "success" ? 1 : 0);
    expect(mocks.destroy).toHaveBeenCalledTimes(outcome === "failure" ? 1 : 0);
    expect(available.install).toHaveBeenCalledOnce();
  });
});
