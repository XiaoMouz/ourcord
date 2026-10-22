// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";
import { bridge } from "./bridge";
import { DialogProvider } from "./dialog";
import App from "./App";

vi.mock("./bridge", () => ({ bridge: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
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
vi.mock("./components/RoomPanel", () => ({ default: () => null }));
vi.mock("./components/VoiceStage", () => ({ default: () => null }));
vi.mock("./components/CallBar", () => ({ default: () => null }));
vi.mock("./components/ChatPane", () => ({ default: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
const loginURLs = { google_url: "https://control.test/google", github_url: "https://control.test/github" };

describe("App startup authentication recovery", () => {
  let container: HTMLDivElement;
  let root: Root;
  let status: ReturnType<typeof deferred<unknown>>;
  let begin: ReturnType<typeof deferred<unknown>>;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    vi.mocked(getCurrent).mockReset().mockResolvedValue(null);
    vi.mocked(onOpenUrl).mockReset().mockResolvedValue(() => {});
    status = deferred();
    begin = deferred();
    vi.mocked(bridge).mockImplementation(async (method) => {
      if (method === "auth.status") return status.promise;
      if (method === "auth.begin") return begin.promise;
      if (method === "auth.exchange") return {};
      if (method === "lobbies.list") return { lobbies: [] };
      if (method === "daemon.snapshot") return { daemon_available: false };
      if (method === "presence.update") return {};
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
  async function mount(strict = false) {
    await act(async () => root.render(strict
      ? <StrictMode><DialogProvider><App /></DialogProvider></StrictMode>
      : <DialogProvider><App /></DialogProvider>));
  }
  const calls = (method: string) => vi.mocked(bridge).mock.calls.filter(([name]) => name === method);
  async function retry() {
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "重试");
    expect(button, "startup failure must offer an actionable retry").toBeDefined();
    await act(async () => button!.click());
  }
  async function signInFromDeepLink() {
    const handler = vi.mocked(onOpenUrl).mock.calls.at(-1)![0];
    await act(async () => handler([`ourcord://auth?code=${"a".repeat(64)}`]));
  }

  it.each([false, true])("preserves the pending verifier while resolving a cold-start callback (StrictMode: %s)", async (strict) => {
    const initialURLs = deferred<string[] | null>();
    const exchange = deferred<void>();
    const fallback = vi.mocked(bridge).getMockImplementation()!;
    let verifier = "pending-login-verifier";
    let authenticated = false;
    vi.mocked(getCurrent).mockReturnValue(initialURLs.promise);
    vi.mocked(bridge).mockImplementation(async (method, params) => {
      if (method === "auth.status") return { authenticated };
      if (method === "auth.begin") {
        verifier = "replacement-login-verifier";
        return loginURLs;
      }
      if (method === "auth.exchange") {
        await exchange.promise;
        if (verifier !== "pending-login-verifier") throw new Error("PKCE verifier replaced");
        authenticated = true;
        return {};
      }
      return fallback(method, params);
    });

    await mount(strict);
    expect(calls("auth.begin")).toHaveLength(0);
    await act(async () => initialURLs.resolve([`ourcord://auth?code=${"d".repeat(64)}`]));
    expect(calls("auth.exchange")).toHaveLength(1);
    expect(calls("auth.begin")).toHaveLength(0);
    await act(async () => exchange.resolve());
    expect(container.textContent).toContain("选择一个房间");
    expect(calls("auth.begin")).toHaveLength(0);
  });

  it("waits for an in-flight URL event when the initial callback is delivered twice", async () => {
    const initialURLs = deferred<string[] | null>();
    const exchange = deferred<unknown>();
    const fallback = vi.mocked(bridge).getMockImplementation()!;
    vi.mocked(getCurrent).mockReturnValue(initialURLs.promise);
    vi.mocked(bridge).mockImplementation(async (method, params) => {
      if (method === "auth.exchange") return exchange.promise;
      return fallback(method, params);
    });
    status.resolve({ authenticated: false });
    await mount();
    await signInFromDeepLink();
    await act(async () => initialURLs.resolve([`ourcord://auth?code=${"a".repeat(64)}`]));
    expect(calls("auth.exchange")).toHaveLength(1);
    expect(calls("auth.begin")).toHaveLength(0);
    status = deferred();
    status.resolve({ authenticated: true });
    await act(async () => exchange.resolve({}));
    expect(container.textContent).toContain("选择一个房间");
  });

  it("shows a recoverable status error and retries only when clicked", async () => {
    vi.useFakeTimers();
    await mount();
    expect(container.textContent).toContain("正在启动 OurCord");
    await act(async () => status.reject(new Error("control unavailable")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("control unavailable");
    expect(container.textContent).not.toContain("正在启动 OurCord");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(calls("auth.status")).toHaveLength(1);
    expect(calls("auth.begin")).toHaveLength(0);

    status = deferred();
    await retry();
    expect(container.textContent).toContain("正在启动 OurCord");
    expect(calls("auth.status")).toHaveLength(2);
    await act(async () => status.resolve({ authenticated: true }));
    expect(container.textContent).toContain("选择一个房间");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps login unavailable until PKCE setup succeeds and lets a failed setup retry", async () => {
    await mount();
    await act(async () => status.resolve({ authenticated: false }));
    expect(container.textContent).not.toContain("发送 Magic Link");
    await act(async () => begin.reject(new Error("store login state: locked")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("store login state: locked");
    begin = deferred();
    await retry();
    await act(async () => begin.resolve(loginURLs));
    expect(container.textContent).toContain("欢迎回来");
    const oauthButtons = [...container.querySelectorAll("button")].filter((button) => /Google|GitHub/.test(button.textContent ?? ""));
    expect(oauthButtons).toHaveLength(2);
    expect(oauthButtons.every((button) => !button.disabled)).toBe(true);
    expect(calls("auth.begin")).toHaveLength(2);
  });

  it("offers another retry when the first retry also fails", async () => {
    await mount();
    await act(async () => status.reject(new Error("offline")));
    status = deferred();
    await retry();
    await act(async () => status.reject(new Error("still offline")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("still offline");
    status = deferred();
    await retry();
    await act(async () => status.resolve({ authenticated: true }));
    expect(container.textContent).toContain("选择一个房间");
    expect(calls("auth.status")).toHaveLength(3);
  });

  it.each(["failure", "logged out"] as const)("ignores a late startup %s after a successful login callback", async (outcome) => {
    await mount();
    const startup = status;
    status = deferred();
    status.resolve({ authenticated: true });
    await signInFromDeepLink();
    expect(container.textContent).toContain("选择一个房间");
    await act(async () => {
      if (outcome === "failure") startup.reject(new Error("old request offline"));
      else startup.resolve({ authenticated: false });
      begin.resolve(loginURLs);
    });
    expect(container.textContent).toContain("选择一个房间");
    expect(calls("auth.begin")).toHaveLength(0);
  });

  it("ignores pending login setup when a newer callback establishes a session", async () => {
    await mount();
    await act(async () => status.resolve({ authenticated: false }));
    status = deferred();
    status.resolve({ authenticated: true });
    await signInFromDeepLink();
    await act(async () => begin.resolve(loginURLs));
    expect(container.textContent).toContain("选择一个房间");
    expect(container.textContent).not.toContain("欢迎回来");
  });

  it("does not start PKCE setup from a stale status while a callback is exchanging", async () => {
    const exchange = deferred<unknown>();
    const fallback = vi.mocked(bridge).getMockImplementation()!;
    vi.mocked(bridge).mockImplementation(async (method, params) => {
      if (method === "auth.exchange") return exchange.promise;
      return fallback(method, params);
    });
    await mount();
    await signInFromDeepLink();
    await act(async () => status.resolve({ authenticated: false }));
    expect(calls("auth.begin")).toHaveLength(0);
    status = deferred();
    status.resolve({ authenticated: true });
    await act(async () => exchange.resolve({}));
    expect(container.textContent).toContain("选择一个房间");
  });

  it("discards the replaced StrictMode startup before checking authentication", async () => {
    await mount(true);
    expect(vi.mocked(getCurrent)).toHaveBeenCalledTimes(2);
    expect(calls("auth.status")).toHaveLength(1);
    await act(async () => status.resolve({ authenticated: false }));
    expect(calls("auth.begin")).toHaveLength(1);
    await act(async () => begin.resolve(loginURLs));
    expect(container.textContent).toContain("欢迎回来");
  });

  it("recovers a failed startup URL event using the same verifier when getCurrent is empty", async () => {
    const exchange = deferred<unknown>();
    const fallback = vi.mocked(bridge).getMockImplementation()!;
    let verifier = "original-verifier";
    let attempts = 0;
    vi.mocked(bridge).mockImplementation(async (method, params) => {
      if (method === "auth.begin") { verifier = "replacement-verifier"; return loginURLs; }
      if (method === "auth.exchange") {
        attempts += 1;
        if (attempts === 1) return exchange.promise;
        if (verifier !== "original-verifier") throw new Error("PKCE verifier replaced");
        return {};
      }
      return fallback(method, params);
    });
    await mount();
    await signInFromDeepLink();
    await act(async () => status.resolve({ authenticated: false }));
    await act(async () => exchange.reject(new Error("exchange temporarily offline")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("exchange temporarily offline");
    expect(container.textContent).not.toContain("正在启动 OurCord");
    expect(calls("auth.begin")).toHaveLength(0);
    status = deferred();
    status.resolve({ authenticated: true });
    await retry();
    expect(calls("auth.exchange")).toHaveLength(2);
    expect(calls("auth.exchange")[1][1]).toEqual(calls("auth.exchange")[0][1]);
    expect(calls("auth.begin")).toHaveLength(0);
    expect(container.textContent).toContain("选择一个房间");
  });

  it("retries a failed startup link read without replacing the pending verifier", async () => {
    vi.mocked(getCurrent).mockRejectedValueOnce(new Error("startup link unavailable"));
    status.resolve({ authenticated: false });
    begin.resolve(loginURLs);
    await mount();
    expect(container.textContent).toContain("startup link unavailable");
    expect(calls("auth.status")).toHaveLength(0);
    expect(calls("auth.begin")).toHaveLength(0);
    await retry();
    expect(vi.mocked(getCurrent)).toHaveBeenCalledTimes(2);
    expect(calls("auth.begin")).toHaveLength(1);
    expect(container.textContent).toContain("欢迎回来");
  });

  it("preserves the original verifier when a cold-start exchange fails transiently", async () => {
    const fallback = vi.mocked(bridge).getMockImplementation()!;
    let verifier = "original-verifier";
    let authenticated = false;
    let attempts = 0;
    vi.mocked(getCurrent).mockResolvedValue([`ourcord://auth?code=${"e".repeat(64)}`]);
    vi.mocked(bridge).mockImplementation(async (method, params) => {
      if (method === "auth.status") return { authenticated };
      if (method === "auth.begin") { verifier = "new-verifier"; return loginURLs; }
      if (method === "auth.exchange") {
        attempts += 1;
        if (attempts === 1) throw new Error("network unavailable");
        if (verifier !== "original-verifier") throw new Error("PKCE verifier replaced");
        authenticated = true;
        return {};
      }
      return fallback(method, params);
    });
    await mount();
    expect(calls("auth.begin")).toHaveLength(0);
    expect(container.textContent).toContain("network unavailable");
    await retry();
    expect(calls("auth.exchange")).toHaveLength(2);
    expect(calls("auth.begin")).toHaveLength(0);
    expect(container.textContent).toContain("选择一个房间");
  });

  it("starts a new login after an expired callback only when explicitly requested", async () => {
    const exchange = deferred<unknown>();
    const fallback = vi.mocked(bridge).getMockImplementation()!;
    vi.mocked(getCurrent).mockResolvedValue([`ourcord://auth?code=${"e".repeat(64)}`]);
    vi.mocked(bridge).mockImplementation(async (method, params) => {
      if (method === "auth.exchange") return exchange.promise;
      return fallback(method, params);
    });
    status.resolve({ authenticated: false });
    begin.resolve(loginURLs);
    await mount();
    expect(calls("auth.begin")).toHaveLength(0);
    await act(async () => exchange.reject(new Error("authorization expired")));
    expect(calls("auth.begin")).toHaveLength(0);
    expect(container.textContent).toContain("authorization expired");
    const restart = [...container.querySelectorAll("button")].find((item) => item.textContent === "重新开始登录");
    expect(restart).toBeDefined();
    await act(async () => restart!.click());
    expect(calls("auth.begin")).toHaveLength(1);
    expect(calls("auth.begin")[0][1]).toEqual({ restart: true });
    expect(container.textContent).toContain("欢迎回来");
  });

  it("exchanges a one-time callback only once across startup and URL events", async () => {
    const url = `ourcord://auth?code=${"b".repeat(64)}`;
    vi.mocked(getCurrent).mockResolvedValue([url]);
    status.resolve({ authenticated: true });
    await mount(true);
    const handler = vi.mocked(onOpenUrl).mock.calls.at(-1)![0];
    await act(async () => handler([url, url]));
    expect(calls("auth.exchange")).toHaveLength(1);
  });

  it("disposes a replaced subscription even when registration finishes after cleanup", async () => {
    const firstRegistration = deferred<() => void>();
    const disposeFirst = vi.fn();
    vi.mocked(onOpenUrl).mockReturnValueOnce(firstRegistration.promise);
    await mount(true);
    await act(async () => firstRegistration.resolve(disposeFirst));
    expect(disposeFirst).toHaveBeenCalledTimes(1);
    const staleHandler = vi.mocked(onOpenUrl).mock.calls[0][0];
    await act(async () => staleHandler([`ourcord://auth?code=${"c".repeat(64)}`]));
    expect(calls("auth.exchange")).toHaveLength(0);
  });

  it("does not exchange a consumed code again when the subsequent status refresh fails", async () => {
    await mount();
    await act(async () => status.resolve({ authenticated: false }));
    await act(async () => begin.resolve(loginURLs));
    status = deferred();
    await signInFromDeepLink();
    await act(async () => status.reject(new Error("status unavailable")));
    await signInFromDeepLink();
    expect(calls("auth.exchange")).toHaveLength(1);
    expect(container.textContent).toContain("status unavailable");
  });

  it("allows a callback retry after the exchange itself fails", async () => {
    await mount();
    await act(async () => status.resolve({ authenticated: false }));
    await act(async () => begin.resolve(loginURLs));
    vi.mocked(bridge).mockRejectedValueOnce(new Error("exchange unavailable"));
    await signInFromDeepLink();
    expect(container.textContent).toContain("exchange unavailable");
    status = deferred();
    status.resolve({ authenticated: true });
    await signInFromDeepLink();
    expect(calls("auth.exchange")).toHaveLength(2);
    expect(container.textContent).toContain("选择一个房间");
  });

  it.each(["Google", "GitHub"])("refreshes the pending OAuth attempt before opening %s", async (provider) => {
    await mount();
    await act(async () => status.resolve({ authenticated: false }));
    await act(async () => begin.resolve(loginURLs));
    begin = deferred();
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(provider));
    expect(button).toBeDefined();
    await act(async () => button!.click());
    expect(calls("auth.begin").at(-1)?.[1]).toEqual({ activate: true });
    expect(vi.mocked(openUrl)).not.toHaveBeenCalled();
    expect(button!.disabled).toBe(true);
    const refreshedURLs = { google_url: "https://control.test/google-fresh", github_url: "https://control.test/github-fresh" };
    await act(async () => begin.resolve(refreshedURLs));
    expect(vi.mocked(openUrl)).toHaveBeenCalledWith(provider === "Google" ? refreshedURLs.google_url : refreshedURLs.github_url);
    expect(button!.disabled).toBe(false);
  });

  it("does not open a stale OAuth URL when activation fails", async () => {
    await mount();
    await act(async () => status.resolve({ authenticated: false }));
    await act(async () => begin.resolve(loginURLs));
    begin = deferred();
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("Google"));
    await act(async () => button!.click());
    await act(async () => begin.reject(new Error("credential store locked")));
    expect(vi.mocked(openUrl)).not.toHaveBeenCalled();
    expect(container.textContent).toContain("credential store locked");
    expect(button!.disabled).toBe(false);
  });
});
