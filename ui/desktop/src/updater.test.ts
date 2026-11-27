import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(async () => true),
  check: vi.fn(),
  relaunch: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

import {
  checkForDesktopUpdate,
  currentDesktopUpdaterState,
  installDesktopUpdate,
  updateProgressPercent,
} from "./updater";

describe("updateProgressPercent", () => {
  it("calculates bounded download progress", () => {
    expect(updateProgressPercent({ status: "downloading", version: "1", downloadedBytes: 25, totalBytes: 100 })).toBe(25);
    expect(updateProgressPercent({ status: "downloading", version: "1", downloadedBytes: 120, totalBytes: 100 })).toBe(100);
  });

  it("returns null without a known total", () => {
    expect(updateProgressPercent({ status: "downloading", version: "1", downloadedBytes: 25 })).toBeNull();
    expect(updateProgressPercent({ status: "idle" })).toBeNull();
  });

  it("does not report an update failure when the native updater is unconfigured", async () => {
    mocks.invoke.mockResolvedValueOnce(false);
    await checkForDesktopUpdate();
    expect(mocks.invoke).toHaveBeenCalledWith("desktop_updater_available");
    expect(mocks.check).not.toHaveBeenCalled();
    expect(currentDesktopUpdaterState()).toEqual({ status: "idle" });
  });

  it("reports native capability errors instead of silently disabling updates", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("native bridge unavailable"));
    await checkForDesktopUpdate();
    expect(currentDesktopUpdaterState()).toEqual({ status: "error", version: undefined });
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("downloads silently and waits to install", async () => {
    const install = vi.fn();
    mocks.check.mockResolvedValueOnce({
      version: "0.1.0-beta.8",
      download: vi.fn(async (onEvent: (event: unknown) => void) => {
        onEvent({ event: "Started", data: { contentLength: 100 } });
        onEvent({ event: "Progress", data: { chunkLength: 100 } });
        onEvent({ event: "Finished" });
      }),
      install,
      close: vi.fn(),
    });

    await checkForDesktopUpdate();
    expect(currentDesktopUpdaterState()).toEqual({ status: "ready", version: "0.1.0-beta.8" });
    expect(install).not.toHaveBeenCalled();

    await installDesktopUpdate();
    expect(install).toHaveBeenCalledOnce();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });
});
