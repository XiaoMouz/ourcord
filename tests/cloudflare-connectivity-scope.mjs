import assert from "node:assert/strict";

export async function verifyConnectivityScope({ control, db, serviceDB, jwt }) {
  const keys = [1, 2, 3, 4].map((n) => Buffer.alloc(32, n).toString("base64"));
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 4; i++) {
    await db.batch([
      db.prepare("INSERT INTO users(id,email,created_at) VALUES (?,?,1)").bind(`scope-u${i}`, `scope-u${i}@example.test`),
      db.prepare("INSERT INTO peers(id,user_id,public_key,ip4,ip6,last_seen) VALUES (?,?,?,?,?,?)").bind(`scope-p${i}`, `scope-u${i}`, keys[i], `198.19.0.${i + 1}`, `fd01::${i + 1}`, now),
    ]);
  }
  await db.batch([
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
      INSERT INTO peers(id,user_id,public_key,ip4,ip6,last_seen)
      SELECT 'history-'||i,'scope-u3',printf('%043d=',i+1000),'history-v4-'||i,'history-v6-'||i,1 FROM n`),
    db.prepare("INSERT INTO peer_presence(public_key,network_id,last_seen) SELECT public_key,'history',1 FROM peers WHERE id LIKE 'history-%'"),
  ]);
  await serviceDB.batch([
    serviceDB.prepare("INSERT INTO lobbies VALUES ('scope-lobby','scope','scope-u0',NULL,1)"),
    serviceDB.prepare("INSERT INTO rooms(id,lobby_id,name,type,vpn_namespace) VALUES ('scope-room','scope-lobby','voice','voice','scope-network')"),
    ...[0, 1, 2].map((i) => serviceDB.prepare("INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES ('scope-lobby',?,'member',1)").bind(`scope-u${i}`)),
  ]);
  const call = (i, path, body) => control.fetch(`https://control.test${path}`, {
    method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${jwt(`scope-u${i}`)}`, "X-Peer-Public-Key": keys[i], "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const config = (i, network = "scope-network") => call(i, `/api/peers/config?room_id=${encodeURIComponent(network)}`);
  const report = (i, target, network = "scope-network", extra = {}) => call(i, "/api/peers/connectivity", { network_id: network, peer_public_key: target, ice_direct: true, wg_reachable: true, ...extra });
  for (const i of [0, 1, 2]) assert.equal((await config(i)).status, 200);
  const statuses = [];
  let writes = 0;
  let maxReads = 0;
  for (let i = 10; i < 30; i++) {
    const response = await report(0, Buffer.alloc(32, i).toString("base64"), `invented-${i}`);
    statuses.push(response.status);
    writes += Number(response.headers.get("X-Test-Topology-Writes"));
    maxReads = Math.max(maxReads, Number(response.headers.get("X-Test-D1-Reads")));
  }
  const count = await db.prepare("SELECT COUNT(*) AS c FROM peer_connectivity").first("c");
  console.log(`fabricated topology reports: statuses=${[...new Set(statuses)]}, retained=${count}, rows_written=${writes}, max_reads=${maxReads}`);
  assert.deepEqual([...new Set(statuses)], [403]);
  assert.equal(count, 0);
  assert.equal(writes, 0);
  assert.ok(maxReads <= 24, "scope rejection must use keyed lookups despite 10,000 unrelated peers and leases");
  assert.equal((await report(0, keys[3])).status, 403, "registered outsider cannot enter the graph");
  assert.equal((await config(0, "invented-room")).status, 200);
  assert.equal(await db.prepare("SELECT network_id FROM peer_presence WHERE public_key=?").bind(keys[0]).first("network_id"), "scope-network", "failed member lookup cannot replace an authenticated lease");
  const accepted = await report(0, keys[1], "scope-network", { reporter_epoch: "scope-epoch", seq: 2 });
  assert.equal(accepted.status, 200);
  console.log(`authorized topology report: reads=${accepted.headers.get("X-Test-D1-Reads")}, writes=${accepted.headers.get("X-Test-Topology-Writes")}`);
  assert.ok(Number(accepted.headers.get("X-Test-D1-Reads")) <= 24);
  assert.equal((await report(0, keys[1], "scope-network", { reporter_epoch: "scope-epoch", seq: 1, ice_direct: false, wg_reachable: false })).status, 200);
  assert.equal((await report(1, keys[2])).status, 200);
  const mesh = await (await config(0)).json();
  assert.equal(mesh.peers.find((p) => p.public_key === keys[2]).next_hop_public_key, keys[1], "A-B-C relay uses authorized directed edges");
  assert.equal(await db.prepare("SELECT seq FROM peer_connectivity WHERE src_public_key=?").bind(keys[0]).first("seq"), 2);
  await db.prepare("DELETE FROM peer_presence WHERE public_key=?").bind(keys[1]).run();
  const departed = await report(0, keys[1]);
  assert.equal(departed.status, 403);
  assert.equal(Number(departed.headers.get("X-Test-Topology-Writes")), 0);
  const pair = `pair:${[keys[0], keys[3]].map((k) => Buffer.from(k, "base64").toString("base64url")).sort().join(".")}`;
  assert.equal((await report(0, keys[3], pair)).status, 200, "exact-key pairs remain independent of service rooms");
  console.log("PASS workerd: topology writes require registered pair endpoints or fresh authorized room presence; A-B-C and report arbitration survive");
}
