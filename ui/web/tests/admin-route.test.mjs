import assert from "node:assert/strict";
import test from "node:test";

async function render(path) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`https://ourcord.mou.best${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("serves the operator fleet console shell at /admin", async () => {
  const response = await render("/admin");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /OurCord 运营面板/);
  assert.match(html, /中继车队与文件后端健康总览/);
  // The login island is client-rendered, but its SSR fallback must include the
  // control-address prompt so the page is usable before hydration.
  assert.match(html, /运营者登录/);
});

test("keeps the admin console out of search indexes", async () => {
  const response = await render("/admin");
  const html = await response.text();
  assert.match(html, /name="robots" content="noindex/i);
});
