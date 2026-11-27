import assert from "node:assert/strict";

export async function verifyDeviceRevocation({ db, control, jwt }) {
  const alice = "revoke-alice", bob = "revoke-bob";
  const aliceKey = Buffer.alloc(32, 41).toString("base64");
  const bobKey = Buffer.alloc(32, 42).toString("base64");
  await db.batch([
    db.prepare("INSERT INTO users(id,email,created_at) VALUES (?, ?, 1),(?, ?, 1)")
      .bind(alice, `${alice}@example.test`, bob, `${bob}@example.test`),
    db.prepare("INSERT INTO peers(id,user_id,public_key,ip4,ip6) VALUES (?,?,?,'198.19.0.41','fd01::41'),(?,?,?,'198.19.0.42','fd01::42')")
      .bind(alice, alice, aliceKey, bob, bob, bobKey),
    db.prepare("INSERT INTO peer_presence VALUES (?,'revoke-network',1)").bind(aliceKey),
    db.prepare(`INSERT INTO peer_connectivity(network_id,src_public_key,dst_public_key,reported_at)
      VALUES ('revoke-network',?,?,1),('revoke-network',?,?,1),('revoke-second',?,?,1)`)
      .bind(aliceKey, bobKey, bobKey, aliceKey, aliceKey, bobKey),
    db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
      INSERT INTO peer_connectivity(network_id,src_public_key,dst_public_key,reported_at)
      SELECT 'revoke-unrelated-'||i,'source-'||i,'target-'||i,1 FROM n`),
  ]);
  const refreshed = await db.prepare(`UPDATE peer_connectivity SET reported_at = reported_at + 1
    WHERE network_id = 'revoke-network' AND src_public_key = ? AND dst_public_key = ?`)
    .bind(aliceKey, bobKey).run();
  assert.equal(refreshed.meta.rows_written, 1, "unchanged endpoint indexes must not amplify a timestamp refresh");
  const call = (user, path, method = "POST", body) => control.fetch(`https://control.test${path}`, {
    method, headers: { Authorization: `Bearer ${jwt(user)}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const enroll = async (user) => {
    const response = await call(user, "/api/devices/enroll", "POST", { public_key: aliceKey });
    assert.equal(response.status, 201);
    return response.json();
  };
  const edges = () => db.prepare("SELECT * FROM peer_connectivity WHERE network_id IN ('revoke-network','revoke-second') ORDER BY network_id,src_public_key,dst_public_key").all();
  const before = (await edges()).results;
  const credential = await enroll(bob);
  const deniedCleanup = await call(bob, `/api/devices/${credential.id}`, "DELETE");
  assert.equal(deniedCleanup.status, 200);
  console.log(`unowned topology cleanup reads=${deniedCleanup.headers.get("X-Test-Topology-Reads")}, remaining edges=${(await edges()).results.length}`);
  assert.deepEqual((await edges()).results, before, "enrolling someone else's public key must not authorize topology deletion");
  assert.equal(await db.prepare("SELECT user_id FROM peers WHERE public_key=?").bind(aliceKey).first("user_id"), alice);
  assert.equal((await call(bob, "/api/auth/device", "POST", { device_token: credential.device_token })).status, 401);

  const own = await enroll(alice);
  assert.equal((await call(bob, `/api/devices/${own.id}`, "DELETE")).status, 404);
  const retired = await call(alice, `/api/devices/${own.id}`, "DELETE");
  assert.equal(retired.status, 200);
  assert.deepEqual((await edges()).results, []);
  assert.equal(await db.prepare("SELECT public_key FROM peer_presence WHERE public_key=?").bind(aliceKey).first(), null);
  assert.equal(await db.prepare("SELECT id FROM peers WHERE public_key=?").bind(aliceKey).first(), null);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM peer_connectivity WHERE network_id LIKE 'revoke-unrelated-%'").first("n"), 10000);
  const costs = [deniedCleanup, retired].map((response) => Number(response.headers.get("X-Test-Topology-Reads")));
  console.log(`topology cleanup reads (unowned/owned)=${costs}`);
  assert(costs.every((reads) => reads <= 30), `topology cleanup scanned unrelated networks: ${costs}`);
  await db.batch([
    db.prepare("DELETE FROM users WHERE id IN (?,?)").bind(alice, bob),
    db.prepare("DELETE FROM peer_connectivity WHERE network_id LIKE 'revoke-unrelated-%'"),
  ]);
  console.log("PASS workerd: device revocation preserves foreign topology and bounds both-direction cleanup reads");
}
