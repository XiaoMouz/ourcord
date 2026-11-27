import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import ts from "typescript";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://ourcord.test/admin" });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, sessionStorage: dom.window.sessionStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
// Compile the actual component next to its imports, without a second bundler
// or a browser test service. Node's test runner isolates this file's DOM.
const compiled = new URL(`../app/admin/.fleet-test-${process.pid}.mjs`, import.meta.url);
writeFileSync(compiled, ts.transpileModule(
  readFileSync(new URL("../app/admin/FleetConsole.tsx", import.meta.url), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } },
).outputText);
const { FleetConsole } = await import(compiled.href);
after(() => { unlinkSync(compiled); dom.window.close(); });

let root, container, requests, poll;
function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function fleet(environment) {
  return { environment, counts: { users: 1, active_peers_5m: 1, active_relays: 0, active_bans: 0 }, relays: [], backends: null, ts: Date.now() };
}
beforeEach(async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  requests = [];
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem("ourcord.admin.controlUrl", "https://control.test");
  sessionStorage.setItem("ourcord.admin.session", JSON.stringify({ controlUrl: "https://control.test", token: "alice-token" }));
  mock.method(globalThis, "setInterval", (callback) => { poll = callback; return 1; });
  mock.method(globalThis, "clearInterval", () => {});
  mock.method(globalThis, "fetch", (url, options) => {
    if (url.endsWith("/api/auth/otp/request")) return Promise.resolve(Response.json({ ok: true }));
    if (url.endsWith("/api/auth/otp/verify")) return Promise.resolve(Response.json({ token: "bob-token" }));
    assert.ok(url.endsWith("/api/control/fleet"));
    const response = deferred();
    requests.push({ ...response, url, options });
    // Deliberately allow a canceled response to arrive: cancellation alone
    // cannot fence a response whose headers/body were already delivered.
    return response.promise;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(FleetConsole)));
  assert.equal(requests.length, 1);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  mock.timers.reset();
  mock.restoreAll();
});
async function click(label) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  assert.ok(button, `button ${label} is visible`);
  await act(async () => button.click());
}
async function type(selector, value) {
  const input = container.querySelector(selector);
  assert.ok(input, `${selector} is visible`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
async function loginBob() {
  await click("退出");
  await type('input[type="email"]', "bob@example.test");
  await click("发送验证码");
  await type('input[inputmode="numeric"]', "123456");
  await click("登录");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.headers.Authorization, "Bearer bob-token");
}

test("slow refreshes share one in-flight request across the timer and refresh button", async () => {
  await click("刷新");
  await click("刷新");
  await act(async () => { for (let i = 0; i < 5; i++) void poll(); });
  assert.equal(requests.length, 1, "one slow request must not accumulate more fleet queries");
  await act(async () => requests[0].resolve(Response.json(fleet("Alice"))));
  await click("刷新");
  assert.equal(requests.length, 2, "refresh resumes after the pending request settles");
});

test("a late response body from Alice cannot replace Bob's fleet", async () => {
  const body = deferred();
  await act(async () => requests[0].resolve({ ok: true, status: 200, json: () => body.promise }));
  await loginBob();
  await act(async () => requests[1].resolve(Response.json(fleet("Bob"))));
  assert.match(container.textContent, /Bob/);
  await act(async () => body.resolve(fleet("Alice")));
  assert.match(container.textContent, /Bob/);
  assert.doesNotMatch(container.textContent, /Alice/);
});

test("a late unauthorized response from Alice cannot log Bob out", async () => {
  await loginBob();
  await act(async () => requests[0].resolve(new Response(null, { status: 401 })));
  assert.equal(JSON.parse(sessionStorage.getItem("ourcord.admin.session")).token, "bob-token");
  await click("刷新");
  assert.equal(requests.length, 2, "settling the old request must not unlock Bob's pending refresh");
  await act(async () => requests[1].resolve(Response.json(fleet("Bob"))));
  assert.match(container.textContent, /Bob/);
});

test("logout cancels the pending request and ignores its later connection error", async () => {
  await click("退出");
  assert.equal(requests[0].options.signal?.aborted, true);
  await act(async () => requests[0].reject(new Error("old connection failed")));
  assert.match(container.textContent, /运营者登录/);
  assert.doesNotMatch(container.textContent, /old connection failed/);
});

test("an expired current session clears its previous fleet before another login", async () => {
  await act(async () => requests[0].resolve(Response.json(fleet("Alice"))));
  await click("刷新");
  await act(async () => requests[1].resolve(new Response(null, { status: 401 })));
  assert.equal(sessionStorage.getItem("ourcord.admin.session"), null);
  await type('input[type="email"]', "bob@example.test");
  await click("发送验证码");
  await type('input[inputmode="numeric"]', "123456");
  await click("登录");
  assert.doesNotMatch(container.textContent, /Alice/, "the previous session's fleet cannot remain visible while Bob loads");
});

test("a stalled request times out and a later refresh can recover", async () => {
  const stalled = requests[0];
  stalled.options.signal.addEventListener("abort", () => stalled.reject(new Error("request timed out")));
  await act(async () => mock.timers.tick(15_000));
  assert.equal(stalled.options.signal.aborted, true);
  assert.match(container.textContent, /request timed out/);
  await click("刷新");
  assert.equal(requests.length, 2);
  await act(async () => requests[1].resolve(Response.json(fleet("Recovered"))));
  assert.match(container.textContent, /Recovered/);
  assert.doesNotMatch(container.textContent, /request timed out/);
});

test("restored sessions keep their issuing server when another tab changes the saved address", async () => {
  await loginBob();
  await act(async () => root.unmount());
  // Another tab's address preference shares localStorage, but not this tab's session.
  localStorage.setItem("ourcord.admin.controlUrl", "https://other-control.test");
  root = createRoot(container);
  await act(async () => root.render(createElement(FleetConsole)));
  assert.equal(requests.at(-1).url, "https://control.test/api/control/fleet");
  assert.equal(requests.at(-1).options.headers.Authorization, "Bearer bob-token");
});

for (const phase of ["headers", "body"]) {
  test(`editing the control address while login ${phase} are pending cannot forward the old server's token`, async () => {
    const pending = deferred();
    const previousFetch = globalThis.fetch;
    mock.method(globalThis, "fetch", (url, options) => url.endsWith("/api/auth/otp/verify")
      ? phase === "headers" ? pending.promise : Promise.resolve({ ok: true, status: 200, json: () => pending.promise })
      : previousFetch(url, options));
    await click("退出");
    await type('input[type="email"]', "bob@example.test");
    await click("发送验证码");
    await type('input[inputmode="numeric"]', "123456");
    await click("登录");
    await type('input[type="url"]', "https://other-control.test");
    await act(async () => pending.resolve(phase === "headers" ? Response.json({ token: "server-a-token" }) : { token: "server-a-token" }));
    assert.deepEqual(requests.filter((r) => r.url.startsWith("https://other-control.test")), [], "server A's credential must never reach server B");
    assert.match(container.textContent, /运营者登录/);
    assert.ok([...container.querySelectorAll("button")].some((b) => b.textContent === "发送验证码"));
  });
}

test("editing email invalidates a pending OTP request and its delayed response", async () => {
  const pending = deferred();
  const previousFetch = globalThis.fetch;
  let requestSignal;
  mock.method(globalThis, "fetch", (url, options) => {
    if (url.endsWith("/api/auth/otp/request")) { requestSignal = options.signal; return pending.promise; }
    return previousFetch(url, options);
  });
  await click("退出");
  await type('input[type="email"]', "alice@example.test");
  await click("发送验证码");
  await type('input[type="email"]', "bob@example.test");
  await act(async () => pending.resolve(Response.json({ ok: true })));
  assert.equal(Boolean(container.querySelector('input[inputmode="numeric"]')), false, "Alice's code must not advance Bob's form");
  assert.equal(requestSignal?.aborted, true);
  assert.equal([...container.querySelectorAll("button")].find((b) => b.textContent === "发送验证码").disabled, false);
});
test("editing email during verification discards a delayed login error", async () => {
  const pending = deferred();
  const previousFetch = globalThis.fetch;
  mock.method(globalThis, "fetch", (url, options) => url.endsWith("/api/auth/otp/verify") ? pending.promise : previousFetch(url, options));
  await click("退出");
  await type('input[type="email"]', "alice@example.test");
  await click("发送验证码");
  await type('input[inputmode="numeric"]', "123456");
  await click("登录");
  await type('input[type="email"]', "bob@example.test");
  await act(async () => pending.resolve(new Response(null, { status: 401 })));
  assert.doesNotMatch(container.textContent, /验证码无效/);
});

test("unmount aborts verification and prevents a late token from restoring the session", async () => {
  const pending = deferred();
  const previousFetch = globalThis.fetch;
  let signal;
  mock.method(globalThis, "fetch", (url, options) => {
    if (url.endsWith("/api/auth/otp/verify")) { signal = options.signal; return pending.promise; }
    return previousFetch(url, options);
  });
  await click("退出");
  await type('input[type="email"]', "alice@example.test");
  await click("发送验证码");
  await type('input[inputmode="numeric"]', "123456");
  await click("登录");
  await act(async () => root.unmount());
  await act(async () => pending.resolve(Response.json({ token: "late-token" })));
  root = createRoot(container);
  await act(async () => root.render(createElement(FleetConsole)));
  assert.equal(signal?.aborted, true);
  assert.match(container.textContent, /运营者登录/);
  assert.equal(requests.length, 1, "unmounted login must not leave a stored credential");
});

test("legacy bare tokens require login instead of inheriting a shared server address", async () => {
  await click("退出");
  await act(async () => root.unmount());
  sessionStorage.setItem("ourcord.admin.token", "unbound-token");
  localStorage.setItem("ourcord.admin.controlUrl", "https://other-control.test");
  root = createRoot(container);
  await act(async () => root.render(createElement(FleetConsole)));
  assert.equal(requests.length, 1);
  assert.equal(sessionStorage.getItem("ourcord.admin.token"), null);
  assert.match(container.textContent, /运营者登录/);
});

test("malformed stored sessions stay unauthenticated", async () => {
  await click("退出");
  for (const stored of ["not-json", JSON.stringify({ token: "unbound" }), JSON.stringify({ token: 42, controlUrl: "https://other-control.test" })]) {
    await act(async () => root.unmount());
    sessionStorage.setItem("ourcord.admin.session", stored);
    root = createRoot(container);
    await act(async () => root.render(createElement(FleetConsole)));
    assert.match(container.textContent, /运营者登录/);
  }
  assert.equal(requests.length, 1);
});

test("a stalled OTP request times out and releases the login form for retry", async () => {
  const pending = deferred();
  const previousFetch = globalThis.fetch;
  let first = true;
  mock.method(globalThis, "fetch", (url, options) => {
    if (url.endsWith("/api/auth/otp/request") && first) {
      first = false;
      options.signal.addEventListener("abort", () => pending.reject(new Error("login request timed out")));
      return pending.promise;
    }
    return previousFetch(url, options);
  });
  await click("退出");
  await type('input[type="email"]', "alice@example.test");
  await click("发送验证码");
  await act(async () => mock.timers.tick(15_000));
  assert.match(container.textContent, /login request timed out/);
  await click("发送验证码");
  assert.equal(Boolean(container.querySelector('input[inputmode="numeric"]')), true);
  assert.doesNotMatch(container.textContent, /login request timed out/);
});

test("settling a canceled login request cannot release a newer pending request", async () => {
  const pending = [deferred(), deferred()];
  const previousFetch = globalThis.fetch;
  let index = 0;
  mock.method(globalThis, "fetch", (url, options) => url.endsWith("/api/auth/otp/request") ? pending[index++].promise : previousFetch(url, options));
  await click("退出");
  await type('input[type="email"]', "alice@example.test");
  await click("发送验证码");
  await type('input[type="email"]', "bob@example.test");
  await click("发送验证码");
  await act(async () => pending[0].resolve(Response.json({ ok: true })));
  const sendButton = [...container.querySelectorAll("button")].find((b) => b.textContent === "发送验证码");
  assert.ok(sendButton);
  assert.equal(sendButton.disabled, true);
  await act(async () => pending[1].resolve(Response.json({ ok: true })));
  assert.equal(Boolean(container.querySelector('input[inputmode="numeric"]')), true);
});
