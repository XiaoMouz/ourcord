import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";

export type UpdaterState =
  | { status: "idle" }
  | { status: "downloading"; version: string; downloadedBytes: number; totalBytes?: number }
  | { status: "ready"; version: string }
  | { status: "installing"; version: string }
  | { status: "error"; version?: string };

const listeners = new Set<(state: UpdaterState) => void>();
let state: UpdaterState = { status: "idle" };
let update: Update | null = null;
let checkPromise: Promise<void> | null = null;
let downloadPromise: Promise<void> | null = null;
let installPromise: Promise<void> | null = null;
let started = false;

function publish(next: UpdaterState) {
  state = next;
  listeners.forEach((listener) => listener(next));
}

function downloadProgress(version: string) {
  let downloadedBytes = 0;
  let totalBytes: number | undefined;
  return (event: DownloadEvent) => {
    if (event.event === "Started") {
      totalBytes = event.data.contentLength;
      downloadedBytes = 0;
    } else if (event.event === "Progress") {
      downloadedBytes += event.data.chunkLength;
    }
    if (event.event !== "Finished") {
      publish({ status: "downloading", version, downloadedBytes, totalBytes });
    }
  };
}

export function checkForDesktopUpdate(): Promise<void> {
  if (checkPromise || downloadPromise || update) return checkPromise ?? downloadPromise ?? Promise.resolve();
  checkPromise = (async () => {
    try {
      const available = await check();
      if (!available) {
        publish({ status: "idle" });
        return;
      }
      update = available;
      publish({ status: "downloading", version: available.version, downloadedBytes: 0 });
      downloadPromise = available.download(downloadProgress(available.version));
      await downloadPromise;
      if (!installPromise) publish({ status: "ready", version: available.version });
    } catch {
      const version = update?.version;
      update = null;
      downloadPromise = null;
      publish({ status: "error", version });
    } finally {
      checkPromise = null;
    }
  })();
  return checkPromise;
}

export function installDesktopUpdate(): Promise<void> {
  if (installPromise) return installPromise;
  if (!update) return Promise.resolve();
  const installing = update;
  installPromise = (async () => {
    try {
      publish({ status: "installing", version: installing.version });
      await downloadPromise;
      await installing.install();
      update = null;
      downloadPromise = null;
      await relaunch();
    } catch (error) {
      publish({ status: "error", version: installing.version });
      throw error;
    } finally {
      installPromise = null;
    }
  })();
  return installPromise;
}

export async function retryDesktopUpdate() {
  if (update) await update.close().catch(() => undefined);
  update = null;
  downloadPromise = null;
  publish({ status: "idle" });
  await checkForDesktopUpdate();
}

function hasPendingUpdate() {
  return update !== null || installPromise !== null;
}

function startUpdater() {
  if (started || import.meta.env.DEV) return;
  started = true;
  void checkForDesktopUpdate();
  window.setInterval(() => void checkForDesktopUpdate(), 6 * 60 * 60 * 1000);

  const appWindow = getCurrentWindow();
  void appWindow.onCloseRequested(async (event) => {
    if (!hasPendingUpdate()) return;
    event.preventDefault();
    try {
      await installDesktopUpdate();
    } catch {
      // A failed update must not make the application impossible to close.
      await appWindow.destroy();
    }
  });
}

export function useDesktopUpdater() {
  const [current, setCurrent] = useState<UpdaterState>(state);
  useEffect(() => {
    listeners.add(setCurrent);
    startUpdater();
    return () => { listeners.delete(setCurrent); };
  }, []);
  return current;
}

export function currentDesktopUpdaterState(): UpdaterState {
  return state;
}

export function updateProgressPercent(current: UpdaterState): number | null {
  if (current.status !== "downloading" || !current.totalBytes || current.totalBytes <= 0) return null;
  return Math.min(100, Math.round(current.downloadedBytes / current.totalBytes * 100));
}
