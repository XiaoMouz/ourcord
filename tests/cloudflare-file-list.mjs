import assert from "node:assert/strict";

export async function verifyFileListScan({ db, service, metered, jwt }) {
  const headers = { Authorization: `Bearer ${jwt("file-list-owner")}`, "Content-Type": "application/json" };
  await db.batch([
    db.prepare("INSERT INTO lobbies VALUES ('file-list-lobby','files','file-list-owner',NULL,1)"),
    db.prepare("INSERT INTO rooms(id,lobby_id,name) VALUES ('file-list-room','file-list-lobby','chat')"),
    db.prepare("INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES ('file-list-lobby','file-list-owner','owner',1)"),
    db.prepare("INSERT INTO file_policies(lobby_id) VALUES ('file-list-lobby')"),
  ]);
  // An owner can allow unlimited permanent files on their own backend.
  assert.equal((await service.fetch("https://service.test/api/lobbies/file-list-lobby/file-policy", {
    method: "PUT", headers, body: JSON.stringify({ retain_days: 0, max_total_files: 0 }),
  })).status, 200);
  const registered = await service.fetch("https://service.test/api/backends", {
    method: "POST", headers, body: JSON.stringify({ base_url: "https://files.test" }),
  });
  assert.equal(registered.status, 201);
  const backend = await registered.json();
  const pending = await service.fetch("https://service.test/api/rooms/file-list-room/files", {
    method: "POST", headers, body: JSON.stringify({ filename: "pending.txt", size_bytes: 1 }),
  });
  assert.equal(pending.status, 201);
  assert.equal((await pending.json()).storage_location, "user_server");
  // Scale the same pending state without making thousands of HTTP requests.
  await db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5000)
    INSERT INTO files(id,room_id,uploader_id,filename,size_bytes,storage_location,storage_key,backend_id,created_at,upload_status,upload_expires_at)
    SELECT 'file-list-'||i,'file-list-room','file-list-owner','test.txt',1,'user_server','files/test/'||i,?,i+100,
      CASE i%2 WHEN 0 THEN 'pending' ELSE 'failed' END,9999999999 FROM n`).bind(backend.id).run();
  await db.prepare(`INSERT INTO files(id,room_id,uploader_id,filename,size_bytes,storage_location,storage_key,backend_id,created_at)
    VALUES ('file-list-done','file-list-room','file-list-owner','done.txt',1,'user_server','files/done',?,1)`).bind(backend.id).run();
  const costs = [];
  for (const populated of [true, false]) {
    const response = await metered.fetch("https://service.test/api/rooms/file-list-room/files", { headers });
    assert.equal(response.status, 200);
    const { files } = await response.json();
    assert.deepEqual(files.map((file) => file.id), populated ? ["file-list-done"] : []);
    const reads = Number(response.headers.get("X-Test-File-List-Reads"));
    console.log(`file list: uploaded=${files.length}, reads=${reads}`);
    costs.push(reads);
    if (populated) await db.prepare("DELETE FROM files WHERE id='file-list-done'").run();
  }
  await db.prepare("DELETE FROM lobbies WHERE id='file-list-lobby'").run();
  await db.prepare("DELETE FROM file_backends WHERE id=?").bind(backend.id).run();
  assert.ok(costs.every((reads) => reads <= 10), `one-file/empty listings scanned ${costs} rows`);
  console.log("PASS workerd: attachment file listing skips unfinished records with bounded reads, including an empty result");
}
