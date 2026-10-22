import assert from "node:assert/strict";
import { request } from "node:http";

// Exercise actual HTTP/1.1 chunked ingress, not a Request with a forged header.
function chunkedPost(url, payload, { contentType = "application/json", leaveOpen = false, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "POST", agent: false, headers: { "Content-Type": contentType, ...headers } }, (res) => {
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

export async function verifyJSONBodyLimits({ mf, db, jwt }) {
  const controlURL = new URL("/api/auth/desktop/exchange", await mf.ready);
  const serviceURL = new URL("/api/rooms/R2/messages", await mf.unsafeGetDirectURL("service"));
  const headers = { Authorization: `Bearer ${jwt()}` };
  const oversized = JSON.stringify({ content: "small message", padding: "x".repeat(32 * 1024) });
  const control = await chunkedPost(controlURL, oversized);
  const form = await chunkedPost(new URL("/api/auth/desktop/magic/confirm", controlURL),
    `token=invalid&padding=${"x".repeat(32 * 1024)}`, { contentType: "application/x-www-form-urlencoded" });
  const response = await chunkedPost(serviceURL, oversized, { headers });
  console.log(`streamed bodies over limit: control HTTP=${control.status}, form HTTP=${form.status}, service=${response.status}`);
  assert.deepEqual([control.status, form.status, response.status], [413, 413, 413]);
  assert.equal(await db.prepare("SELECT id FROM messages WHERE room_id='R2'").first(), null);

  // The client deliberately never finishes the JSON or ends the upload.
  // A guard that buffers to EOF or awaits one tee cancellation would hang.
  const unfinished = await chunkedPost(controlURL, `{"padding":"${"x".repeat(4096)}`, { leaveOpen: true });
  assert.equal(unfinished.status, 413);
  assert.equal((await chunkedPost(serviceURL, `{"padding":"${"x".repeat(32768)}`, { leaveOpen: true, headers })).status, 413);
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
    const response = await chunkedPost(serviceURL, body + " ".repeat(size - body.length), { headers });
    assert.equal(response.status, size === 16384 ? 201 : 413);
  }
  await db.prepare("DELETE FROM messages WHERE room_id='R2'").run();
  console.log("PASS workerd: chunked HTTP and streamed message JSON enforce byte limits and accept exact boundaries");
}
