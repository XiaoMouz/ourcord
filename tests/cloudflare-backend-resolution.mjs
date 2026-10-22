import assert from "node:assert/strict";

export async function verifyBackendResolutionScans({ db, service, jwt }) {
  const headers = (user) => ({ Authorization: `Bearer ${jwt(user)}`, "Content-Type": "application/json" });
  const call = (user, path, method, body) => service.fetch(`https://service.test/api/${path}`, {
    method, headers: headers(user), body: body === undefined ? undefined : JSON.stringify(body),
  });
  await db.batch([
    db.prepare("INSERT INTO lobbies VALUES ('resolution-lobby','files','resolution-owner',NULL,1), ('resolution-foreign','other','resolution-other',NULL,1)"),
    db.prepare("INSERT INTO rooms(id,lobby_id,name) VALUES ('resolution-room','resolution-lobby','files')"),
    db.prepare("INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES ('resolution-lobby','resolution-owner','owner',1)"),
    db.prepare("INSERT INTO file_policies(lobby_id,retain_days,max_total_files) VALUES ('resolution-lobby',0,0)"),
  ]);
  const register = async (user, extra = {}) => {
    const response = await call(user, "backends", "POST", { base_url: "https://resolution-files.test", ...extra });
    assert.equal(response.status, 201);
    return (await response.json()).id;
  };
  const own = await register("resolution-owner");
  const shared = await register("resolution-other");
  assert.equal((await call("resolution-other", `backends/${shared}/shares`, "POST", { user_id: "resolution-owner" })).status, 201);
  const lobby = await register("resolution-owner", { lobby_id: "resolution-lobby" });
  const costs = [];
  async function upload(label, backendID, location) {
    const response = await call("resolution-owner", "rooms/resolution-room/files", "POST", { filename: "test.txt", size_bytes: 1 });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.backend_id ?? null, backendID);
    assert.equal(body.storage_location, location);
    const reads = Number(response.headers.get("X-Test-D1-Reads"));
    const writes = Number(response.headers.get("X-Test-D1-Writes"));
    console.log(`backend resolution: ${label}, reads=${reads}, writes=${writes}`);
    costs.push({ label, reads, writes });
  }
  async function list(label) {
    const response = await call("resolution-owner", "backends", "GET");
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).backends.map((backend) => backend.id).sort(), [own, shared, lobby].sort());
    const reads = Number(response.headers.get("X-Test-D1-Reads"));
    const writes = Number(response.headers.get("X-Test-D1-Writes"));
    console.log(`backend resolution: ${label}, reads=${reads}, writes=${writes}`);
    costs.push({ label, reads, writes });
  }
  await upload("small registry", own, "user_server");
  await list("list small registry");
  // Scale ordinary registered states without 10,000 HTTP calls. These rows
  // are neither owned by, shared with nor in a lobby of the uploading user.
  await db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
    INSERT INTO file_backends(id,owner_id,lobby_id,base_url,active,created_at)
    SELECT 'resolution-noise-'||i,'resolution-other',
      CASE i%2 WHEN 0 THEN 'resolution-foreign' ELSE NULL END,'https://unrelated.test',1,i FROM n`).run();
  await upload("own with unrelated registry", own, "user_server");
  await list("list with unrelated registry");
  assert.equal((await call("resolution-owner", `backends/${own}`, "DELETE")).status, 200);
  await upload("shared with unrelated registry", shared, "user_server");
  assert.equal((await call("resolution-other", `backends/${shared}/shares/resolution-owner`, "DELETE")).status, 200);
  await upload("lobby with unrelated registry", lobby, "lobby_server");
  assert.equal((await call("resolution-owner", `backends/${lobby}`, "DELETE")).status, 200);
  await upload("R2 fallback with unrelated registry", null, "r2");
  const r2Keys = await db.prepare("SELECT storage_key FROM files WHERE room_id='resolution-room' AND storage_location='r2'").all();
  await db.prepare("DELETE FROM lobbies WHERE id IN ('resolution-lobby','resolution-foreign')").run();
  // These test reservations never uploaded an object; release their budgets.
  for (const { storage_key } of r2Keys.results) await db.prepare("DELETE FROM r2_deletion_queue WHERE storage_key=?").bind(storage_key).run();
  await db.prepare("DELETE FROM file_backends WHERE owner_id IN ('resolution-owner','resolution-other')").run();
  assert.ok(costs.every(({ reads }) => reads < 100), `upload scanned unrelated backend rows: ${JSON.stringify(costs)}`);
  console.log("PASS workerd: upload storage priority is preserved without scanning unrelated backend registrations");
}
