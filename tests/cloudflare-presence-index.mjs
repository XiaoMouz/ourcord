import assert from "node:assert/strict";

export async function verifyPresenceIndex({ db, service, jwt }) {
  await db.batch([
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 1000)
      INSERT INTO lobbies(id,name,owner_id,created_at) SELECT 'Lpfk-'||i, 'friends', 'other', 1 FROM n`),
    db.prepare(`INSERT INTO rooms(id,lobby_id,name,type)
      SELECT 'Rpfk-'||id, id, 'voice', 'voice' FROM lobbies WHERE id LIKE 'Lpfk-%'`),
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 5000)
      INSERT INTO lobby_members(lobby_id,user_id,role,joined_at)
      SELECT 'Lpfk-'||((i+4)/5), 'pfk-other-'||i, 'member', 1 FROM n`),
    db.prepare(`INSERT INTO lobby_presence(lobby_id,user_id,last_seen,voice_room_id)
      SELECT lobby_id,user_id,1,CASE WHEN rowid % 2 = 0 THEN 'Rpfk-'||lobby_id ELSE NULL END
      FROM lobby_members WHERE lobby_id LIKE 'Lpfk-%'`),
    db.prepare("INSERT INTO lobbies VALUES ('LpfkOwn1','own','pfk-owner',NULL,1), ('LpfkOwn2','own','pfk-owner',NULL,1)"),
    db.prepare(`INSERT INTO rooms(id,lobby_id,name,type) VALUES
      ('RpfkOwn1','LpfkOwn1','voice','voice'), ('RpfkKeep','LpfkOwn1','keep','text'),
      ('RpfkOwn2','LpfkOwn2','voice','voice')`),
    db.prepare(`INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES
      ('LpfkOwn1','pfk-owner','owner',1), ('LpfkOwn2','pfk-owner','owner',1), ('LpfkOwn1','pfk-friend','member',1)`),
    db.prepare("INSERT INTO lobby_presence VALUES ('LpfkOwn1','pfk-friend',123,'RpfkOwn1')"),
  ]);
  const call = (path, method = "POST", body, user = "pfk-owner") => service.fetch(`https://service.test${path}`, {
    method, headers: { Authorization: `Bearer ${jwt(user)}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const own = async () => (await db.prepare("SELECT lobby_id,voice_room_id FROM lobby_presence WHERE user_id = 'pfk-owner' ORDER BY lobby_id").all()).results;
  const pulse = (voice_room_id) => call("/api/presence", "POST", { voice_room_id });
  assert.equal((await pulse("RpfkOwn1")).status, 200);
  // Ordinary 30-second heartbeats must not rewrite a stable voice index.
  for (let i = 0; i < 3; i++) {
    const response = await pulse("RpfkOwn1");
    assert.equal(response.status, 200);
    const writes = Number(response.headers.get("X-Test-Mutation-Writes"));
    const reads = Number(response.headers.get("X-Test-Mutation-Reads"));
    console.log(`stable presence heartbeat: mutation rows_read=${reads}, rows_written=${writes}`);
    assert.equal(writes, 2, "heartbeat must write each of the two presence rows only once");
    assert.ok(reads <= 40, `heartbeat scanned ${reads} rows`);
  }
  assert.deepEqual(await own(), [{ lobby_id: "LpfkOwn1", voice_room_id: "RpfkOwn1" }, { lobby_id: "LpfkOwn2", voice_room_id: null }]);
  assert.equal((await pulse("RpfkOwn2")).status, 200);
  assert.deepEqual(await own(), [{ lobby_id: "LpfkOwn1", voice_room_id: null }, { lobby_id: "LpfkOwn2", voice_room_id: "RpfkOwn2" }]);
  assert.equal((await pulse("")).status, 200);
  assert.equal((await pulse("Rpfk-Lpfk-1")).status, 403);
  assert.ok((await own()).every((row) => row.voice_room_id === null));
  assert.equal((await pulse("RpfkOwn1")).status, 200);
  await db.prepare("UPDATE lobby_presence SET last_seen = 123 WHERE user_id = 'pfk-owner'").run();
  const beforeFailure = (await db.prepare("SELECT * FROM lobby_presence WHERE user_id = 'pfk-owner' ORDER BY lobby_id").all()).results;
  await db.prepare(`CREATE TRIGGER test_presence_transition_failure BEFORE UPDATE OF voice_room_id ON lobby_presence
    WHEN NEW.user_id = 'pfk-owner' BEGIN SELECT RAISE(ABORT, 'injected presence transition failure'); END`).run();
  try {
    await pulse("RpfkOwn2").then(
      async (r) => { assert.equal(r.status, 500); await r.text(); },
      (error) => assert.match(String(error), /injected presence transition failure/),
    );
    assert.deepEqual((await db.prepare("SELECT * FROM lobby_presence WHERE user_id = 'pfk-owner' ORDER BY lobby_id").all()).results, beforeFailure);
  } finally {
    await db.prepare("DROP TRIGGER test_presence_transition_failure").run();
  }
  const concurrent = await Promise.all([pulse("RpfkOwn1"), pulse("RpfkOwn2")]);
  assert.deepEqual(concurrent.map((r) => r.status), [200, 200]);
  const selected = (await own()).map((row) => row.voice_room_id);
  assert.ok(JSON.stringify(selected) === '["RpfkOwn1",null]' || JSON.stringify(selected) === '[null,"RpfkOwn2"]');
  assert.equal((await pulse("RpfkOwn1")).status, 200);
  assert.equal((await call("/api/rooms/RpfkOwn1", "DELETE", undefined, "pfk-friend")).status, 403);
  const response = await call("/api/rooms/RpfkOwn1", "DELETE");
  assert.equal(response.status, 200);
  const reads = Number(response.headers.get("X-Test-Mutation-Reads"));
  console.log(`room deletion: mutation rows_read=${reads}, rows_written=${response.headers.get("X-Test-Mutation-Writes")}`);
  assert.ok(reads <= 80, `deleting one room scanned ${reads} rows of unrelated presence`);
  assert.ok((await own()).every((row) => row.voice_room_id === null));
  assert.deepEqual(await db.prepare("SELECT last_seen,voice_room_id FROM lobby_presence WHERE user_id = 'pfk-friend'").first(), { last_seen: 123, voice_room_id: null });
  assert.equal((await pulse("RpfkOwn1")).status, 403);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM lobby_presence WHERE lobby_id LIKE 'Lpfk-%'").first()).n, 5000);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM lobby_presence WHERE lobby_id LIKE 'Lpfk-%' AND voice_room_id IS NOT NULL").first()).n, 2500);
  console.log("PASS workerd: room deletion uses the presence FK index without adding stable heartbeat writes");
}
