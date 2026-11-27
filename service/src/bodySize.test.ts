import { describe, expect, it, vi } from "vitest";
import { checkBodySize } from "./auth";

function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let index = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === chunks.length) return controller.close();
      controller.enqueue(chunks[index++]);
    },
    cancel,
  });
  const init = { method: "POST", body, headers, duplex: "half" };
  return { request: new Request("https://test/api", init), cancel, reads: () => index };
}

const encode = (text: string) => new TextEncoder().encode(text);

describe("bounded request bodies", () => {
  it.each([undefined, "0", "2"])(
    "rejects oversized streams with advisory content-length %j", async (length) => {
      const headers: Record<string, string> = length === undefined ? {} : { "content-length": length };
      const { request } = streamed([encode("{}"), encode(" ".repeat(15))], headers);
      const response = await checkBodySize(request, 16);
      expect(response?.status).toBe(413);
      expect(await response?.json()).toEqual({ error: "request body too large" });
    },
  );

  it("preserves exact-limit UTF-8 bytes, headers and the original parser", async () => {
    const data = encode(JSON.stringify({ name: "中文😀" }));
    const { request } = streamed([data.slice(0, 11), data.slice(11)], { authorization: "Bearer unchanged" });
    expect(await checkBodySize(request, data.byteLength)).toBeNull();
    expect(request.bodyUsed).toBe(false);
    expect(request.headers.get("authorization")).toBe("Bearer unchanged");
    expect(await request.json()).toEqual({ name: "中文😀" });
    const { request: oversized } = streamed([data]);
    expect((await checkBodySize(oversized, data.byteLength - 1))?.status).toBe(413);
  });

  it("stops consuming a long stream as soon as it exceeds the cap", async () => {
    const { request, cancel, reads } = streamed(Array.from({ length: 100 }, () => new Uint8Array(8)));
    expect((await checkBodySize(request, 16))?.status).toBe(413);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(reads()).toBeLessThan(10);
  });

  it("returns without EOF or waiting for source cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(17)); },
      cancel,
    });
    const init = { method: "POST", body, duplex: "half" };
    const request = new Request("https://test/api", init);
    expect((await checkBodySize(request, 16))?.status).toBe(413);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  });

  it.each(["-1", "1e3", "12junk", "1.5", ""])("rejects invalid content-length %j", async (length) => {
    const { request } = streamed([encode("{}")], { "content-length": length });
    expect((await checkBodySize(request, 16))?.status).toBe(400);
  });

  it("rejects a declared oversize without waiting for the body", async () => {
    const { request, cancel } = streamed([], { "content-length": "999999999999999999999999" });
    expect((await checkBodySize(request, 16))?.status).toBe(413);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("returns 400 for a failed input stream", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("broken upload")); },
    });
    const init = { method: "POST", body, duplex: "half" };
    expect((await checkBodySize(new Request("https://test/api", init), 16))?.status).toBe(400);
  });

  it("leaves bounded malformed JSON and empty bodies to existing parsers", async () => {
    const { request } = streamed([encode("{")]);
    expect(await checkBodySize(request, 16)).toBeNull();
    await expect(request.json()).rejects.toThrow();
    expect(await checkBodySize(new Request("https://test/api", { method: "POST" }), 16)).toBeNull();
  });

  it("preserves form decoding and relay-style clone-then-parse", async () => {
    const { request } = streamed([encode("token=abc%2Bdef")], { "content-type": "application/x-www-form-urlencoded" });
    expect(await checkBodySize(request, 16)).toBeNull();
    expect((await request.formData()).get("token")).toBe("abc+def");
    const { request: relay } = streamed([encode('{"mode":"personal"}')]);
    expect(await checkBodySize(relay, 32)).toBeNull();
    const clone = relay.clone();
    expect(await relay.json()).toEqual({ mode: "personal" });
    expect(await clone.json()).toEqual({ mode: "personal" });
  });
});
