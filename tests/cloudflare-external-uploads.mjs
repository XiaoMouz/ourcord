import assert from "node:assert/strict";
import { createServer } from "node:http";

// Exercise external HEAD interleavings through the actual service Worker and
// D1, using an ephemeral local backend rather than a production file server.
export async function verifyExternalUploadFinalization(db, call, service) {
  const objects = new Map();
  const gates = [];
  let nextHead;
  const backend = createServer(async (request, response) => {
    const path = new URL(request.url, "http://backend.test").pathname;
    if (request.method === "PUT") {
      let size = 0;
      for await (const chunk of request) size += chunk.length;
      objects.set(path, size);
      response.end();
      return;
    }
    if (request.method === "GET") {
      response.end(); // scheduled health probe
      return;
    }
    const gate = nextHead;
    nextHead = undefined;
    gate?.entered();
    const reply = gate ? await gate.reply : {};
    response.writeHead(reply.status ?? (objects.has(path) ? 200 : 404), {
      "Content-Length": String(reply.length ?? objects.get(path) ?? 0),
    });
    response.end();
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  try {
    await db.batch([
      db.prepare("INSERT INTO lobbies VALUES ('Lexternal','external','u1',NULL,1)"),
      db.prepare("INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES ('Lexternal','u1','owner',1)"),
      db.prepare("INSERT INTO rooms(id,lobby_id,name) VALUES ('Rexternal','Lexternal','files'), ('Rexternal-delete','Lexternal','delete me')"),
    ]);
    const registered = await call("/api/backends", "POST", JSON.stringify({
      base_url: `http://127.0.0.1:${backend.address().port}`, upload_secret: "runtime-backend-secret",
    }));
    assert.equal(registered.status, 201);
    const initiate = async (room = "Rexternal") => {
      const response = await call(`/api/rooms/${room}/files`, "POST", JSON.stringify({
        filename: "file.txt", size_bytes: 5, mime_type: "text/plain",
      }));
      assert.equal(response.status, 201);
      const file = await response.json();
      assert.equal(file.storage_location, "user_server");
      assert.equal((await fetch(file.upload_url, { method: "PUT", body: "hello" })).status, 200);
      return file;
    };
    const complete = (file) => call(file.complete_url, "POST", JSON.stringify({ upload_token: file.upload_token }));
    const hold = async (file) => {
      let entered, release;
      const started = new Promise((resolve) => { entered = resolve; });
      const reply = new Promise((resolve) => { release = resolve; });
      nextHead = { entered, reply, release };
      gates.push(nextHead);
      const response = complete(file);
      await Promise.race([started, response.then(async (result) => {
        throw new Error(`completion returned before HEAD: ${result.status} ${await result.text()}`);
      })]);
      return { response, release: (reply = {}) => release(reply) };
    };
    const row = (file) => db.prepare("SELECT upload_status,last_upload_error FROM files WHERE id = ?").bind(file.id).first();
    const deleted = await initiate("Rexternal-delete");
    const deleting = await hold(deleted);
    try {
      assert.equal((await call("/api/rooms/Rexternal-delete", "DELETE")).status, 200);
    } finally { deleting.release(); }
    assert.equal((await deleting.response).status, 409);
    assert.equal(await row(deleted), null);

    for (const cleanup of [false, true]) {
      const expired = await initiate();
      const pending = await hold(expired);
      try {
        await db.prepare("UPDATE files SET upload_expires_at = 0 WHERE id = ?").bind(expired.id).run();
        if (cleanup) await service.scheduled({ scheduledTime: Date.now(), cron: "0 * * * *" });
      } finally { pending.release(); }
      assert.equal((await pending.response).status, 409);
      if (!cleanup) await service.scheduled({ scheduledTime: Date.now(), cron: "0 * * * *" });
      assert.equal(await row(expired), null);
    }
    for (const reply of [{}, { length: 4 }, { status: 503 }]) {
      const file = await initiate();
      const pending = await hold(file);
      try {
        assert.equal((await complete(file)).status, 200);
      } finally { pending.release(reply); }
      assert.equal((await pending.response).status, 409);
      assert.deepEqual(await row(file), { upload_status: "uploaded", last_upload_error: null });
    }
    console.log("PASS workerd: external completion rejects removed/expired reservations and preserves published uploads");
  } finally {
    for (const gate of gates) gate.release({});
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
  }
}
