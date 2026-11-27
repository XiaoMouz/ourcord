import assert from "node:assert/strict";

export async function verifyErrorBoundaries({ mf, service, db, controlDB, jwt }) {
  await controlDB.prepare("INSERT INTO users(id,email,display_name,created_at) VALUES ('error-boundary','boundary@example.test','before',1)").run();
  await controlDB.prepare(`CREATE TRIGGER test_profile_failure BEFORE UPDATE ON users
    WHEN OLD.id = 'error-boundary' BEGIN SELECT RAISE(ABORT, 'injected profile failure'); END`).run();
  await db.prepare(`CREATE TRIGGER test_message_failure BEFORE INSERT ON messages
    WHEN NEW.content = 'error boundary message' BEGIN SELECT RAISE(ABORT, 'injected message failure'); END`).run();
  const controlURL = new URL("/api/me", await mf.ready);
  const updateProfile = () => fetch(controlURL, {
    method: "PATCH", headers: { Authorization: `Bearer ${jwt("error-boundary")}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ display_name: "after" }),
  });
  const send = () => service.fetch("https://service.test/api/rooms/R2/messages", {
    method: "POST", headers: { Authorization: `Bearer ${jwt()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: "error boundary message" }),
  });
  let controlFailure, serviceFailure;
  try {
    const observe = async (call) => {
      try {
        const response = await call();
        return { status: response.status, type: response.headers.get("content-type"), body: await response.text() };
      } catch (error) {
        return { rejected: String(error) };
      }
    };
    controlFailure = await observe(updateProfile);
    serviceFailure = await observe(send);
    console.log("Worker error boundaries:", JSON.stringify({ control: controlFailure, service: serviceFailure }));
    assert.equal(await controlDB.prepare("SELECT display_name FROM users WHERE id='error-boundary'").first("display_name"), "before");
    assert.equal(await db.prepare("SELECT id FROM messages WHERE content='error boundary message'").first(), null);
  } finally {
    await controlDB.prepare("DROP TRIGGER test_profile_failure").run();
    await db.prepare("DROP TRIGGER test_message_failure").run();
  }
  for (const result of [controlFailure, serviceFailure]) {
    assert.equal(result.status, 500);
    assert.match(result.type, /^application\/json/);
    assert.deepEqual(JSON.parse(result.body), { error: "Internal server error" });
  }
  assert.equal((await updateProfile()).status, 200);
  assert.equal((await send()).status, 201);
  console.log("PASS workerd: asynchronous D1 failures become sanitized JSON 500 responses and subsequent requests recover");
}
