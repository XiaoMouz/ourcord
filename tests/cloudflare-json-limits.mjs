import assert from "node:assert/strict";
import { request } from "node:http";

// Exercise actual HTTP/1.1 chunked ingress, not a Request with a forged header.
function chunkedPost(url, payload, { contentType = "application/json", leaveOpen = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", agent: false, headers: { "Content-Type": contentType } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        resolve({ status: res.statusCode, body });
        if (leaveOpen) req.destroy();
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("chunked request timed out")));
    req.write(payload.slice(0, 8));
    if (leaveOpen) req.write(payload.slice(8));
    else req.end(payload.slice(8));
    assert.equal(req.getHeader("content-length"), undefined);
  });
}

function stream(payload) {
  const bytes = new TextEncoder().encode(payload);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(offset + 257, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

export async function verifyJSONBodyLimits({ mf, service, db, jwt }) {
  const controlURL = new URL("/api/auth/desktop/exchange", await mf.ready);
  const oversized = JSON.stringify({ content: "small message", padding: "x".repeat(32 * 1024) });
  const control = await chunkedPost(controlURL, oversized);
  const form = await chunkedPost(new URL("/api/auth/desktop/magic/confirm", controlURL),
    `token=invalid&padding=${"x".repeat(32 * 1024)}`, { contentType: "application/x-www-form-urlencoded" });
  const response = await service.fetch("https://service.test/api/rooms/R2/messages", {
    method: "POST", headers: { Authorization: `Bearer ${jwt()}`, "Content-Type": "application/json" },
    body: stream(oversized), duplex: "half",
  });
  await response.text();
  console.log(`streamed bodies over limit: control HTTP=${control.status}, form HTTP=${form.status}, service=${response.status}`);
  assert.deepEqual([control.status, form.status, response.status], [413, 413, 413]);
  assert.equal(await db.prepare("SELECT id FROM messages WHERE room_id='R2'").first(), null);

  // The client deliberately never finishes the JSON or ends the upload.
  // A guard that buffers to EOF or awaits one tee cancellation would hang.
  const unfinished = await chunkedPost(controlURL, `{"padding":"${"x".repeat(4096)}`, { leaveOpen: true });
  assert.equal(unfinished.status, 413);
  const relayURL = new URL("/api/relay/register", controlURL);
  const relay = await chunkedPost(relayURL, '{"mode":"personal"}');
  assert.equal(relay.status, 401, "bounded relay peek still reaches its authentication gate");
  assert.equal((await chunkedPost(relayURL, oversized)).status, 413);

  for (const size of [2048, 2049]) {
    const payload = "{}" + " ".repeat(size - 2);
    const result = await chunkedPost(controlURL, payload);
    assert.equal(result.status, size === 2048 ? 400 : 413);
    assert.match(result.body, size === 2048 ? /invalid authorization code/ : /request body too large/);
  }
  for (const size of [16384, 16385]) {
    const body = JSON.stringify({ content: "boundary" });
    const response = await service.fetch("https://service.test/api/rooms/R2/messages", {
      method: "POST", headers: { Authorization: `Bearer ${jwt()}`, "Content-Type": "application/json" },
      body: stream(body + " ".repeat(size - body.length)), duplex: "half",
    });
    assert.equal(response.status, size === 16384 ? 201 : 413);
    await response.text();
  }
  await db.prepare("DELETE FROM messages WHERE room_id='R2'").run();
  console.log("PASS workerd: chunked HTTP and streamed message JSON enforce byte limits and accept exact boundaries");
}
