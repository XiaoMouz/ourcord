import assert from "node:assert/strict";

export async function verifyStatusCounts({ db, control, jwt }) {
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare("INSERT INTO users(id,email,created_at) VALUES ('status-operator','status@example.test',1)"),
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
      INSERT INTO peers(id,user_id,public_key,ip4,ip6,last_seen)
      SELECT 'status-peer-'||i,'status-operator',printf('%043d=',i),'status-v4-'||i,'status-v6-'||i,1 FROM n`),
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
      INSERT INTO relay_servers(id,owner_id,hostname,active,registered_at,last_heartbeat)
      SELECT 'status-relay-'||i,'status-operator','relay-'||i||'.test',1,1,1 FROM n`),
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
      INSERT INTO bans(id,target_type,target_id,created_at,expires_at)
      SELECT 'status-ban-'||i,'peer','status-peer-'||i,1,2 FROM n`),
    db.prepare("UPDATE peers SET last_seen=? WHERE id='status-peer-1'").bind(now),
    db.prepare("UPDATE relay_servers SET last_heartbeat=? WHERE id='status-relay-1'").bind(now),
    db.prepare("UPDATE bans SET expires_at=NULL WHERE id='status-ban-1'"),
    db.prepare("UPDATE bans SET expires_at=? WHERE id='status-ban-2'").bind(now + 3600),
  ]);
  const updates = await db.batch([
    db.prepare("UPDATE peers SET last_seen=? WHERE id='status-peer-1'").bind(now + 1),
    db.prepare("UPDATE relay_servers SET last_heartbeat=? WHERE id='status-relay-1'").bind(now + 1),
  ]);
  assert.deepEqual(updates.map((result) => result.meta.rows_written), [1, 1], "public statistics must not add heartbeat writes");
  const call = (path) => control.fetch(`https://control.test${path}`, { headers: { Authorization: `Bearer ${jwt("status-operator")}`, "Cache-Control": "no-cache" } });
  const first = await call("/api/control/status");
  assert.equal(first.status, 200);
  const snapshot = await first.json();
  assert.deepEqual(snapshot.counts, { users: 1, active_peers_5m: 1, active_relays: 1, active_bans: 2 });
  console.log(`cold public status reads=${first.headers.get("X-Test-Count-Reads")}`);
  assert.equal(first.headers.get("Cache-Control"), "public, max-age=15");
  await db.prepare("UPDATE peers SET last_seen=? WHERE id='status-peer-2'").bind(now).run();
  for (const path of ["/api/control/status", "/api/control/status?random=1", "/api/control/status?random=2"]) {
    const response = await call(path);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), snapshot);
    console.log(`${path} cached reads=${response.headers.get("X-Test-Count-Reads")}`);
    assert.deepEqual(JSON.parse(response.headers.get("X-Test-Count-Reads")), {}, "repeat public requests must not query D1");
  }
  const fleet = await call("/api/control/fleet");
  assert.equal(fleet.status, 200);
  assert.equal((await fleet.json()).counts.active_peers_5m, 2, "operator fleet remains fresh");
  await new Promise((resolve) => setTimeout(resolve, 15_100));
  const refreshed = await call("/api/control/status");
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).counts.active_peers_5m, 2);
  assert.ok(JSON.parse(refreshed.headers.get("X-Test-Count-Reads")).peers > 0, "expired native cache must recompute counts");
  await db.batch([
    db.prepare("DELETE FROM bans WHERE id LIKE 'status-ban-%'"),
    db.prepare("DELETE FROM users WHERE id='status-operator'"),
  ]);
  console.log("PASS workerd: public statistics cache avoids repeated D1 queries, expires, and preserves fresh operator data and heartbeat write counts");
}
