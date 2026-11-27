import assert from "node:assert/strict";

// The host holds the gate so concurrent workerd requests never share request IO.
export function createRoleWriteGate() {
  let pending;
  return {
    arm() {
      assert.equal(pending, undefined);
      const reached = Promise.withResolvers();
      const released = Promise.withResolvers();
      pending = { reached, released };
      return { reached: reached.promise, resume: () => released.resolve() };
    },
    async fetch() {
      assert.ok(pending, "unexpected role write gate request");
      const gate = pending;
      gate.reached.resolve();
      await gate.released.promise;
      pending = undefined;
      return new Response("continue");
    },
  };
}

export async function verifyMemberRoleConcurrency({ db, service, gate, jwt }) {
  await db.batch([
    db.prepare("INSERT INTO lobbies VALUES ('role-lobby','roles','role-owner',NULL,1), ('role-other','other','role-admin',NULL,1)"),
    db.prepare(`INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES
      ('role-lobby','role-owner','owner',1), ('role-lobby','role-admin','admin',1),
      ('role-lobby','role-target','member',1), ('role-other','role-admin','owner',1)`),
  ]);
  const update = (caller, target, role, paused = false) => service.fetch(
    `https://service.test/api/lobbies/role-lobby/members/role-${target}`, {
      method: "PUT", headers: {
        Authorization: `Bearer ${jwt(`role-${caller}`)}`, "Content-Type": "application/json",
        ...(paused ? { "X-Test-Pause-Role": "1" } : {}),
      }, body: JSON.stringify({ role }),
    });
  const failures = [];
  for (const promotedTarget of [true, false]) {
    const hold = gate.arm();
    const stale = update("admin", "target", "guest", true);
    let timeout;
    try {
      await Promise.race([
        hold.reached,
        stale.then(() => { throw new Error("request returned before role write gate"); }),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("role gate timed out")), 5000); }),
      ]);
      assert.equal((await update("owner", promotedTarget ? "target" : "admin", promotedTarget ? "admin" : "member")).status, 200);
    } finally {
      clearTimeout(timeout);
      hold.resume();
    }
    const response = await stale;
    const target = await db.prepare("SELECT role FROM lobby_members WHERE lobby_id='role-lobby' AND user_id='role-target'").first();
    console.log(`member role race: ${promotedTarget ? "target promoted" : "caller demoted"}, status=${response.status}, target=${target.role}`);
    if (response.status !== 403 || target.role !== (promotedTarget ? "admin" : "member")) failures.push(promotedTarget ? "target promotion" : "caller demotion");
    assert.equal((await update("owner", "target", "member")).status, 200);
  }
  assert.equal((await update("owner", "admin", "admin")).status, 200);
  assert.equal((await update("admin", "target", "guest")).status, 200);
  assert.equal((await update("admin", "target", "guest")).status, 200);
  assert.equal((await update("admin", "owner", "guest")).status, 403);
  assert.equal((await update("owner", "missing", "guest")).status, 404);
  assert.deepEqual(failures, [], "stale role requests bypassed current authorization");
  console.log("PASS workerd: role writes recheck caller and target in the same lobby, preserving ordinary edits and retries");
}
