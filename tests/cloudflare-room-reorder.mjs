import assert from "node:assert/strict";

export async function verifyRoomReorder({ db, service, jwt }) {
  await db.batch([
    db.prepare("INSERT INTO lobbies VALUES ('Lswap','atomic reorder','u1',NULL,1), ('LswapOther','foreign','u2',NULL,1)"),
    db.prepare("INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES ('Lswap','u1','owner',1), ('Lswap','u2','admin',1), ('Lswap','u3','member',1)"),
    db.prepare(`INSERT INTO rooms(id,lobby_id,name,type,position) VALUES
      ('Rswap1','Lswap','one','text',0), ('Rswap2','Lswap','two','text',1),
      ('Rswap3','Lswap','three','text',2), ('RswapVoice','Lswap','voice','voice',3),
      ('RswapForeign','LswapOther','foreign','text',4)`),
  ]);
  const call = (body, user = "u1", suffix = "/reorder") => service.fetch(`https://service.test/api/rooms/Rswap1${suffix}`, {
    method: "PATCH", headers: { Authorization: `Bearer ${jwt(user)}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const positions = async () => (await db.prepare("SELECT id,position FROM rooms WHERE lobby_id = 'Lswap' ORDER BY id").all()).results;
  const swap = { swap_with: "Rswap2", expected_position: 0, position: 1 };
  const initial = await positions();
  assert.equal((await call(swap, "u3")).status, 403);
  assert.equal((await call(swap, "u1", "")).status, 400);
  assert.equal((await call({ position: 1 })).status, 400);
  assert.equal((await call({ ...swap, swap_with: "RswapForeign", position: 4 })).status, 409);
  assert.equal((await call({ ...swap, swap_with: "RswapVoice", position: 3 })).status, 409);
  assert.deepEqual(await positions(), initial);
  const responses = await Promise.all([call(swap), call(swap, "u2")]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await responses.find((r) => r.status === 200).json()).id, "Rswap1");
  assert.deepEqual(await positions(), initial.map((r) => ({ ...r, position: r.id === "Rswap1" ? 1 : r.id === "Rswap2" ? 0 : r.position })));
  assert.equal((await call({ ...swap, expected_position: 1, position: 0 })).status, 200);
  assert.deepEqual(await positions(), initial);

  // Abort the second row's update and verify SQLite rolls back the first too.
  await db.prepare(`CREATE TRIGGER test_swap_abort BEFORE UPDATE OF position ON rooms
    WHEN OLD.id = 'Rswap2' BEGIN SELECT RAISE(ABORT, 'injected swap failure'); END`).run();
  try {
    // Consume the error regardless of whether the Worker surfaces it as a 500
    // or rejects fetch; the invariant is that neither row has changed.
    await call(swap).then(
      async (r) => { assert.equal(r.status, 500); await r.text(); },
      (error) => assert.match(String(error), /injected swap failure/),
    );
    assert.deepEqual(await positions(), initial);
  } finally {
    await db.prepare("DROP TRIGGER test_swap_abort").run();
  }
  assert.equal((await call(swap)).status, 200);
  console.log("PASS workerd: room swaps are atomic, scoped, conflict-aware and roll back on SQL failure");
}
