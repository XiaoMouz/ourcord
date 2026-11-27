import assert from "node:assert/strict";

export async function verifyUploadQuotaScans({ db, service, jwt }) {
  const headers = { Authorization: `Bearer ${jwt("quota-owner")}`, "Content-Type": "application/json" };
  const call = (path, method, body) => service.fetch(`https://service.test/api/${path}`, {
    method, headers, body: JSON.stringify(body),
  });
  await db.batch([
    db.prepare("INSERT INTO lobbies VALUES ('quota-lobby','quotas','quota-owner',NULL,1), ('quota-other','other','quota-owner',NULL,1)"),
    db.prepare(`INSERT INTO rooms(id,lobby_id,name) VALUES ('quota-room','quota-lobby','files'),
      ('quota-second','quota-lobby','more'), ('quota-foreign','quota-other','foreign')`),
    db.prepare("INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES ('quota-lobby','quota-owner','owner',1), ('quota-other','quota-owner','owner',1)"),
    db.prepare("INSERT INTO file_policies(lobby_id) VALUES ('quota-lobby'), ('quota-other')"),
  ]);
  const policy = async (values, lobby = "quota-lobby") => {
    assert.equal((await call(`lobbies/${lobby}/file-policy`, "PUT", values)).status, 200);
  };
  const upload = (room = "quota-room") => call(`rooms/${room}/files`, "POST", { filename: "test.txt", size_bytes: 1 });
  const backend = await call("backends", "POST", { base_url: "https://quota-files.test" });
  assert.equal(backend.status, 201);
  await policy({ retain_days: 0, max_total_files: 0 });
  const sample = await upload();
  assert.equal(sample.status, 201);
  const record = await sample.json();
  assert.equal(record.storage_location, "user_server");
  // Scale the permanent-file state reachable with an unlimited self-hosted
  // backend. Only the file metadata is needed to exercise reservation costs.
  const populate = async (prefix, expires) => db.prepare(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
    INSERT INTO files(id,room_id,uploader_id,filename,size_bytes,storage_location,storage_key,backend_id,created_at,expires_at)
    SELECT ?||i, CASE i%2 WHEN 0 THEN 'quota-room' ELSE 'quota-second' END,
      'quota-owner','test.txt',1,'user_server','files/'||?||i,?,i,? FROM n
  `).bind(prefix, prefix, record.backend_id, expires).run();
  await populate("permanent-", null);
  const checks = [];
  async function check(label, status) {
    const response = await upload();
    assert.equal(response.status, status, label);
    const reads = Number(response.headers.get("X-Test-D1-Reads"));
    const writes = Number(response.headers.get("X-Test-D1-Writes"));
    console.log(`upload quota: ${label}, status=${status}, reads=${reads}, writes=${writes}`);
    checks.push({ label, reads });
  }
  await policy({ max_total_files: 100 });
  await check("permanent history above newly lowered quota", 409);
  await policy({ retain_days: 30, max_temp_files: 100 });
  await check("empty temporary quota with permanent history", 201);
  await policy({ max_temp_files: 0 });
  await populate("temporary-", 9999999999);
  await policy({ max_temp_files: 100 });
  await check("temporary history above quota", 409);
  await db.prepare("DELETE FROM files WHERE expires_at IS NULL").run();
  await policy({ retain_days: 0, max_total_files: 100 });
  await check("empty permanent quota with temporary history", 201);
  await policy({ max_total_files: 0 });
  await check("unlimited quota", 201);
  await policy({ max_temp_files: 1 }, "quota-other");
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => upload("quota-foreign")));
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [201, 409, 409, 409]);
  assert.ok(checks.every(({ reads }) => reads < 500), `quota checks scanned historical rows: ${JSON.stringify(checks)}`);
  console.log("PASS workerd: upload quotas avoid unrelated retention history and stop at the quota, retaining atomic reservations");
}
