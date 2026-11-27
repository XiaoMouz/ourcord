import assert from "node:assert/strict";

export async function verifyProfileNameLimit({ control, controlDB, jwt }) {
  const id = "d".repeat(32);
  // Existing names may be longer: signup historically uses the email prefix.
  const original = "old".repeat(20);
  await controlDB.prepare("INSERT INTO users(id,email,display_name,created_at) VALUES (?,?,?,1)")
    .bind(id, `${id}@name-limits.test`, original).run();
  const headers = { Authorization: `Bearer ${jwt(id)}`, "Content-Type": "application/json" };
  for (const value of ["n".repeat(49), "n".repeat(64), "n".repeat(48), "名".repeat(48), "😀".repeat(24)]) {
    const response = await control.fetch("https://control.test/api/me", {
      method: "PATCH", headers, body: JSON.stringify({ display_name: value }),
    });
    const valid = value.length <= 48;
    assert.equal(response.status, valid ? 200 : 413);
    const saved = await controlDB.prepare("SELECT display_name FROM users WHERE id=?").bind(id).first();
    assert.equal(saved.display_name, valid ? value : original);
  }
  console.log("PASS workerd: profile updates reject 49/64 UTF-16 units without changing stored names and accept 48-unit ASCII, Chinese and emoji names");
}
