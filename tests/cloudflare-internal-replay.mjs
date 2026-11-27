import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";

export async function verifyInternalReplay({ service, db, secret }) {
  const path = "/api/internal/rooms/R1/member-ids";
  function signed() {
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = randomBytes(16).toString("hex");
    const sig = createHmac("sha256", secret).update(`${ts}\n${nonce}\nGET\n${path}`).digest("base64url");
    return { "X-Internal-Ts": ts, "X-Internal-Nonce": nonce, "X-Internal-Sig": sig };
  }
  const call = (headers) => service.fetch(`https://service.test${path}`, { headers });
  for (const failWrites of [false, true]) {
    if (failWrites) {
      await db.prepare(`CREATE TRIGGER test_nonce_failure BEFORE INSERT ON internal_nonces
        BEGIN SELECT RAISE(FAIL, 'test nonce persistence failure'); END`).run();
    }
    try {
      const headers = signed();
      assert.equal((await call({ ...headers, "X-Internal-Sig": "invalid" })).status, 403);
      const responses = await Promise.all(Array.from({ length: 8 }, () => call(headers)));
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 403, 403, 403, 403, 403, 403, 403],
        `nonce write failure=${failWrites}: only one concurrent copy may reach the member query`);
      assert.deepEqual((await responses.find((r) => r.status === 200).json()).user_ids, ["u1"]);
      assert.equal((await call(headers)).status, 403);
      // Availability fallback still admits a different correctly signed call.
      assert.equal((await call(signed())).status, 200);
    } finally {
      if (failWrites) await db.prepare("DROP TRIGGER test_nonce_failure").run();
    }
  }
  console.log("PASS workerd: concurrent signed replays rejected with healthy and failed nonce writes");
}
