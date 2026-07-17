import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const installerAsset = readFileSync(new URL("../app/release.ts", import.meta.url), "utf8")
  .match(/^export const installerAsset = "(.+)";$/m)?.[1];

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("https://ourcord.mou.best/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the OurCord download landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>OurCord — 朋友在线，数据在你手里<\/title>/i);
  assert.match(html, /朋友在线/);
  assert.match(html, /下载 Windows Beta/);
  assert.ok(installerAsset, "installerAsset extracted from app/release.ts");
  assert.ok(html.includes(`/downloads/${installerAsset}`), "download link uses installerAsset");
  assert.match(html, /当前安装包未签名/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/);
});

test("publishes production social metadata", async () => {
  const response = await render();
  const html = await response.text();
  assert.match(html, /property="og:image" content="https:\/\/ourcord\.mou\.best\/og\.png"/i);
  assert.match(html, /name="twitter:card" content="summary_large_image"/i);
  assert.match(html, /lang="zh-CN"/i);
});
