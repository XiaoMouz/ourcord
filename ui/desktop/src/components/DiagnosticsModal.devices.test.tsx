// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge, type LocalProfile } from "../bridge";
import { DialogProvider } from "../dialog";
import DiagnosticsModal from "./DiagnosticsModal";

vi.mock("../bridge", () => ({ bridge: vi.fn() }));

function pendingIdentity() {
  let resolve!: (value: { profile: LocalProfile }) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<{ profile: LocalProfile }>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

describe("DiagnosticsModal device identity loading", () => {
  let container: HTMLDivElement;
  let root: Root;
  let identity: ReturnType<typeof pendingIdentity>;
  const onError = vi.fn();
  const revoked = () => vi.mocked(bridge).mock.calls.filter(([method]) => method === "devices.revoke");
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    identity = pendingIdentity();
    vi.mocked(bridge).mockImplementation(async (method) => {
      if (method === "daemon.profile") return identity.promise;
      if (method === "devices.list") return { devices: [
        { id: "current", name: "This computer", public_key: "current-key", created_at: 1 },
        { id: "other", name: "Other computer", public_key: "other-key", created_at: 1 },
      ] };
      if (method === "devices.revoke") return { revoked: true };
      throw new Error(`Unexpected method: ${method}`);
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const mount = () => act(async () => root.render(<DialogProvider>
    <DiagnosticsModal snapshot={{ daemon_available: true }} close={vi.fn()} onError={onError} />
  </DialogProvider>));
  const buttonFor = (name: string) => Array.from(container.querySelectorAll("li"))
    .find((row) => row.textContent?.includes(name))!.querySelector<HTMLButtonElement>("button")!;
  async function clickAndConfirm(button: HTMLButtonElement) {
    await act(async () => button.click());
    const confirm = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
      .find((b) => b.textContent === "吊销");
    if (confirm) await act(async () => confirm.click());
  }

  it("cannot revoke this computer while its identity request is pending", async () => {
    await mount();
    await clickAndConfirm(buttonFor("This computer"));
    expect(revoked()).toEqual([]);
    expect(buttonFor("Other computer").disabled).toBe(true);
    await act(async () => identity.resolve({ profile: { public_key: "current-key", enrolled: true } }));
    expect(buttonFor("This computer").disabled).toBe(true);
    expect(buttonFor("Other computer").disabled).toBe(false);
  });

  it("keeps revocation blocked if local identity lookup fails", async () => {
    await mount();
    await act(async () => identity.reject(new Error("daemon unavailable")));
    await clickAndConfirm(buttonFor("This computer"));
    expect(revoked()).toEqual([]);
    expect(container.textContent).toContain("无法确认本机设备");
  });

  it("does not treat an empty profile key as a known local identity", async () => {
    await mount();
    await act(async () => identity.resolve({ profile: { public_key: "", enrolled: false } }));
    await clickAndConfirm(buttonFor("This computer"));
    expect(revoked()).toEqual([]);
  });

  it("allows revoking another device once the local identity is known", async () => {
    await mount();
    await act(async () => identity.resolve({ profile: { public_key: "current-key", enrolled: true } }));
    await clickAndConfirm(buttonFor("This computer"));
    expect(revoked()).toEqual([]);
    await clickAndConfirm(buttonFor("Other computer"));
    expect(revoked()).toEqual([["devices.revoke", { id: "other" }]]);
  });

  it("can retry failed identity loading without enabling revocation before recovery", async () => {
    await mount();
    await act(async () => identity.reject(new Error("daemon unavailable")));
    identity = pendingIdentity();
    const retry = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "重试本机识别")!;
    expect(retry).toBeDefined();
    await act(async () => retry.click());
    expect(buttonFor("Other computer").disabled).toBe(true);
    await act(async () => identity.resolve({ profile: { public_key: "current-key", enrolled: true } }));
    expect(container.textContent).not.toContain("无法确认本机设备");
    expect(buttonFor("This computer").disabled).toBe(true);
    await clickAndConfirm(buttonFor("Other computer"));
    expect(revoked()).toEqual([["devices.revoke", { id: "other" }]]);
  });
});
