import assert from "node:assert/strict";

export async function verifyMessageRevisions({ db, service, jwt }) {
  await db.batch([
    db.prepare("INSERT INTO lobbies VALUES ('revision-lobby','chat','moderator',NULL,1)"),
    db.prepare("INSERT INTO rooms(id,lobby_id,name) VALUES ('revision-room','revision-lobby','chat')"),
    db.prepare("INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES ('revision-lobby','author','member',1), ('revision-lobby','reader','member',1), ('revision-lobby','moderator','owner',1)"),
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<119)
      INSERT INTO messages(id,room_id,user_id,content,created_at)
      SELECT 'revision-'||i,'revision-room','author','body '||i,i FROM n`),
  ]);
  const read = async () => {
    const response = await service.fetch("https://service.test/api/rooms/revision-room/messages", {
      headers: { Authorization: `Bearer ${jwt("reader")}` },
    });
    assert.equal(response.status, 200);
    assert.ok(Number(response.headers.get("X-Test-D1-Rows-Read")) <= 55, "ordinary polling must stay bounded");
    return response.json();
  };
  const remove = (id, user = "author") => service.fetch(`https://service.test/api/rooms/revision-room/messages/${id}`, {
    method: "DELETE", headers: { Authorization: `Bearer ${jwt(user)}` },
  });
  const before = await read();
  assert.equal(before.messages.length, 50);
  assert.equal((await remove("revision-0", "reader")).status, 403);
  const removed = await remove("revision-0");
  assert.equal(removed.status, 200);
  assert.equal(await db.prepare("SELECT 1 FROM messages WHERE id='revision-0'").first(), null);
  const after = await read();
  assert.deepEqual(after.messages, before.messages, "deleting cached history leaves the latest page unchanged");
  console.log(`message deletion revision: before=${before.deletion_revision}, after=${after.deletion_revision}, delete writes=${removed.headers.get("X-Test-D1-Rows-Written")}`);
  assert.equal(before.deletion_revision, 0);
  assert.equal(after.deletion_revision, 1);
  assert.equal(Number(removed.headers.get("X-Test-D1-Rows-Written")), 2, "one message delete plus one room revision write");
  assert.equal((await remove("revision-0")).status, 404);
  assert.equal((await read()).deletion_revision, 1);

  await db.prepare(`CREATE TRIGGER test_revision_failure BEFORE UPDATE ON rooms
    WHEN OLD.id='revision-room' BEGIN SELECT RAISE(ABORT,'injected revision failure'); END`).run();
  try {
    await assert.rejects(remove("revision-1", "moderator"), /injected revision failure/);
    assert.notEqual(await db.prepare("SELECT 1 FROM messages WHERE id='revision-1'").first(), null);
    assert.equal((await read()).deletion_revision, 1);
  } finally { await db.prepare("DROP TRIGGER test_revision_failure").run(); }
  assert.equal((await remove("revision-1", "moderator")).status, 200);
  assert.equal((await read()).deletion_revision, 2);
  const cascade = await db.prepare("DELETE FROM lobbies WHERE id='revision-lobby'").run();
  // The parent room is already gone during its message FK cascade: no extra
  // room writes for the 118 remaining messages, 3 members, room and lobby.
  console.log(`message revision cascade: rows_written=${cascade.meta.rows_written}`);
  assert.equal(cascade.meta.rows_written, 123);
  console.log("PASS workerd: authorized message deletion advances a room revision atomically, including older cached messages and SQL failure rollback");
}
