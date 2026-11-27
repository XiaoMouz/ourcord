import assert from "node:assert/strict";

export async function verifyControlCors({ control, db, kv, jwt }) {
  await db.batch([
    db.prepare("INSERT INTO users(id,email,created_at) VALUES ('cors-operator','operator@example.test',1), ('cors-member','member@example.test',1)"),
  ]);
  // Miniflare permits loopback origins through its own development proxy.
  const origin = "http://localhost:4173";
  let requestId = 0;
  const call = (path, init = {}) => control.fetch(`https://control.example.test${path}`, {
    ...init, headers: { Origin: origin, "Content-Type": "application/json", "CF-Connecting-IP": `192.0.2.${++requestId}`, ...init.headers },
  });
  function readable(response, status) {
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(response.headers.get("Access-Control-Allow-Credentials"), null);
  }
  const preflight = await call("/api/auth/otp/request", { method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
  readable(preflight, 200);
  assert.match(preflight.headers.get("Access-Control-Allow-Headers"), /Content-Type/);
  const requested = await call("/api/auth/otp/request", { method: "POST", body: JSON.stringify({ email: "operator@example.test" }) });
  readable(requested, 200);
  const otp = await kv.get("otp:operator@example.test");
  assert.match(otp, /^\d{6}$/);
  const verified = await call("/api/auth/otp/verify", { method: "POST", body: JSON.stringify({ email: "operator@example.test", otp }) });
  readable(verified, 200);
  const session = await verified.json();
  assert.equal(session.user_id, "cors-operator");
  assert.equal(await kv.get("otp:operator@example.test"), null);
  const fleet = await call("/api/control/fleet", { headers: { Authorization: `Bearer ${session.token}` } });
  readable(fleet, 200);
  assert.equal((await fleet.json()).counts.users, 2);
  readable(await call("/api/control/fleet"), 401);
  readable(await call("/api/control/fleet", { headers: { Authorization: `Bearer ${jwt("cors-member")}` } }), 403);
  await db.prepare("INSERT INTO bans(id,target_type,target_id,created_at) VALUES ('cors-ban','user','cors-operator',1)").run();
  readable(await call("/api/control/fleet", { headers: { Authorization: `Bearer ${session.token}` } }), 401);
  readable(await call("/api/auth/otp/verify", { method: "POST", body: JSON.stringify({ email: "operator@example.test", otp: "wrong" }) }), 401);
  const oversized = JSON.stringify({ email: "x".repeat(1100) });
  readable(await call("/api/auth/otp/request", { method: "POST", headers: { "Content-Length": String(Buffer.byteLength(oversized)) }, body: oversized }), 413);
  const cookieError = await call("/api/auth/oauth/google/callback");
  readable(cookieError, 400);
  assert.match(cookieError.headers.get("Set-Cookie"), /Max-Age=0/);
  console.log("PASS workerd: cross-origin OTP, fleet and error responses preserve CORS, auth, OTP consumption and cookie clearing");
}
