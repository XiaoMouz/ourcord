import assert from "node:assert/strict";

export async function verifyPresenceRetirement({ db, service, jwt }) {
  // 1,000 independent small lobbies, five other members each. Expired presence
  // is intentionally retained by the app, so old accounts remain in this table.
  await db.batch([
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 1000)
      INSERT INTO lobbies(id,name,owner_id,created_at) SELECT 'presence-cost-'||i, 'friends', 'other', 1 FROM n`),
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 5000)
      INSERT INTO lobby_members(lobby_id,user_id,role,joined_at)
      SELECT 'presence-cost-'||((i+4)/5), 'presence-other-'||i, 'member', 1 FROM n`),
    db.prepare(`INSERT INTO lobby_members(lobby_id,user_id,role,joined_at)
      VALUES ('presence-cost-1','presence-caller','member',1), ('presence-cost-2','presence-caller','member',1)`),
    db.prepare(`INSERT INTO lobby_presence(lobby_id,user_id,last_seen)
      SELECT lobby_id,user_id,1 FROM lobby_members WHERE lobby_id LIKE 'presence-cost-%'`),
  ]);
  const count = async () => (await db.prepare("SELECT COUNT(*) AS n FROM lobby_presence WHERE lobby_id LIKE 'presence-cost-%'").first()).n;
  assert.equal(await count(), 5002);
  for (const user of ["presence-caller", "presence-caller", "presence-nonmember"]) {
    const response = await service.fetch("https://service.test/api/presence", {
      method: "DELETE", headers: { Authorization: `Bearer ${jwt(user)}` },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { online: false });
    const reads = Number(response.headers.get("X-Test-D1-Rows-Read"));
    console.log(`presence retirement: ${user}, rows_read=${reads}, rows_written=${response.headers.get("X-Test-D1-Rows-Written")}`);
    assert.ok(reads <= 40, `retiring one account scanned ${reads} rows in other accounts' presence`);
    assert.equal(await count(), 5000);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM lobby_presence WHERE user_id = 'presence-caller'").first()).n, 0);
  }
  console.log("PASS workerd: logout/close presence retirement reads only the account's memberships, including repeat and nonmember calls");
}
