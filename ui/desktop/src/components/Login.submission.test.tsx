// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Login from "./Login";

describe("Magic Link submission", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onMagic = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    onMagic.mockClear();
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
    input.value = email;
    const button = container.querySelector("button")!;
    return { input, button, form: input.form! };
  }

  it.each(["", "invalid-address", "two@@example.com"])("rejects invalid email %j", async (email) => {
    const { button, form } = await render(email);
    button.click();
    form.requestSubmit();
    expect(onMagic).not.toHaveBeenCalled();
  });

  it.each([[true, 0], [false, 15]] as const)("honors busy=%s and cooldown=%i", async (busy, seconds) => {
    const { button, form } = await render("test@example.com", busy, seconds);
    expect(button.disabled).toBe(true);
    button.click();
    form.requestSubmit();
    expect(onMagic).not.toHaveBeenCalled();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])("leaves composition Enter to the input method", async (composition) => {
    const { input } = await render("test@example.com");
    const event = new KeyboardEvent("keydown", { key: "Enter", repeat: true, ...composition, bubbles: true, cancelable: true });
    expect(input.dispatchEvent(event)).toBe(true);
    expect(onMagic).not.toHaveBeenCalled();
  });

  it("cancels the browser's default submission on repeated Enter", async () => {
    const { input } = await render("test@example.com");
    const event = new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true, cancelable: true });
    expect(input.dispatchEvent(event)).toBe(false);
    expect(onMagic).not.toHaveBeenCalled();
  });

  it("submits the trimmed address after the pending request completes", async () => {
    await render("", true);
    const { form } = await render("  test@example.com  ");
    form.requestSubmit();
    expect(onMagic).toHaveBeenCalledExactlyOnceWith("test@example.com");
  });

  it("submits the current valid address once per activation", async () => {
    const { input, button, form } = await render("first@example.com");
    expect(button.form).toBe(form);
    expect(button.type).toBe("submit");
    button.click();
    expect(onMagic.mock.calls).toEqual([["first@example.com"]]);

    input.value = "second@example.com";
    form.requestSubmit();
    expect(onMagic.mock.calls).toEqual([["first@example.com"], ["second@example.com"]]);
  });
});
