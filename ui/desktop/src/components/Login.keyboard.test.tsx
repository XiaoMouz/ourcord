// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Login from "./Login";

describe("Login keyboard submission", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onMagic = vi.fn();

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    onMagic.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(email: string, busy = false, cooldownSeconds = 0) {
    await act(async () => root.render(<Login busy={busy} cooldownSeconds={cooldownSeconds} onMagic={onMagic} />));
    const input = container.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, email);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input;
  }

  async function enter(input: HTMLInputElement, options: KeyboardEventInit = {}) {
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...options })));
  }

  it.each(["", "invalid-address"])("does not submit an invalid email: %s", async (email) => {
    await enter(await render(email));
    expect(onMagic).not.toHaveBeenCalled();
  });

  it("does not submit while a request is pending", async () => {
    await enter(await render("test@example.com", true));
    expect(onMagic).not.toHaveBeenCalled();
  });

  it("does not submit during the resend cooldown", async () => {
    await enter(await render("test@example.com", false, 30));
    expect(onMagic).not.toHaveBeenCalled();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }, { repeat: true }])("does not submit composition or repeated Enter: %j", async (options) => {
    await enter(await render("test@example.com"), options);
    expect(onMagic).not.toHaveBeenCalled();
  });

  it("submits a valid email with Enter", async () => {
    await enter(await render("test@example.com"));
    expect(onMagic).toHaveBeenCalledExactlyOnceWith("test@example.com");
  });

  it.each(["keyboard", "button"])("normalizes the same email for %s submission", async (method) => {
    const input = await render("  test@example.com  ");
    if (method === "keyboard") await enter(input);
    else await act(async () => container.querySelector<HTMLButtonElement>("button.btn-primary")!.click());
    expect(onMagic).toHaveBeenCalledExactlyOnceWith("test@example.com");
  });

  it("allows Enter after the pending request completes", async () => {
    await render("test@example.com", true);
    await enter(await render("test@example.com"));
    expect(onMagic).toHaveBeenCalledExactlyOnceWith("test@example.com");
  });
});
