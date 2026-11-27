import assert from "node:assert/strict";

export function createRevokeGate() {
  let pending;
  return {
    arm() {
      assert.equal(pending, undefined);
      const reached = Promise.withResolvers(), released = Promise.withResolvers();
      pending = { reached, released };
      return { reached: reached.promise, resume: () => released.resolve() };
    },
    async fetch() {
      assert.ok(pending, "unexpected revoke gate request");
      const gate = pending;
      gate.reached.resolve();
      await gate.released.promise;
      pending = undefined;
      return new Response("continue");
    },
  };
}

export async function verifyDeviceRotationRace({ db, control, gate, jwt }) {
  const user = "rotation-owner", key = Buffer.alloc(32, 71).toString("base64");
  await db.batch([
    db.prepare("INSERT INTO users(id,email,created_at) VALUES (?, ?, 1)").bind(user, `${user}@example.test`),
    db.prepare("INSERT INTO peers(id,user_id,public_key,ip4,ip6) VALUES ('rotation-peer',?,?,'198.19.0.71','fd01::71')").bind(user, key),
    db.prepare("INSERT INTO peer_presence VALUES (?,'rotation-network',1)").bind(key),
    db.prepare("INSERT INTO peer_connectivity(network_id,src_public_key,dst_public_key,reported_at) VALUES ('rotation-network',?,'other',1)").bind(key),
  ]);
  const call = (path, method = "POST", body, paused = false) => control.fetch(`https://control.test/api/${path}`, {
    method, headers: { Authorization: `Bearer ${jwt(user)}`, "Content-Type": "application/json", ...(paused ? { "X-Test-Pause-Revoke": "1" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const enroll = async () => {
    const response = await call("devices/enroll", "POST", { public_key: key });
    assert.equal(response.status, 201);
    return response.json();
  };
  const old = await enroll();
  const hold = gate.arm();
  const stale = call(`devices/${old.id}`, "DELETE", undefined, true);
  let timeout, fresh;
  try {
    await Promise.race([
      hold.reached,
      stale.then(() => { throw new Error("revoke returned before batch gate"); }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("revoke gate timed out")), 5000); }),
    ]);
    fresh = await enroll();
  } finally {
    clearTimeout(timeout);
    hold.resume();
  }
  const response = await stale;
  const peer = await db.prepare("SELECT id FROM peers WHERE public_key=?").bind(key).first();
  const presence = await db.prepare("SELECT public_key FROM peer_presence WHERE public_key=?").bind(key).first();
  const edges = (await db.prepare("SELECT src_public_key FROM peer_connectivity WHERE network_id='rotation-network'").all()).results;
  const credential = await db.prepare("SELECT revoked_at FROM device_tokens WHERE id=?").bind(fresh.id).first();
  console.log(`device rotation race: revoke=${response.status}, peer=${!!peer}, presence=${!!presence}, edges=${edges.length}, freshRevoked=${credential.revoked_at}`);
  assert.equal(response.status, 404);
  assert.deepEqual(peer, { id: "rotation-peer" });
  assert.deepEqual(presence, { public_key: key });
  assert.deepEqual(edges, [{ src_public_key: key }]);
  assert.equal(credential.revoked_at, null);
  assert.equal((await call("auth/device", "POST", { device_token: fresh.device_token })).status, 200);
  assert.equal((await call(`devices/${fresh.id}`, "DELETE")).status, 200);
  assert.equal((await call("auth/device", "POST", { device_token: fresh.device_token })).status, 401);
  assert.equal(await db.prepare("SELECT id FROM peers WHERE public_key=?").bind(key).first(), null);
  await db.prepare("DELETE FROM users WHERE id=?").bind(user).run();
  console.log("PASS workerd: stale revocation cannot remove a rotated device's live peer, presence or topology");
}
