import assert from "node:assert/strict";
import { createNameCache } from "../ui/desktop/src/names.ts";

export async function verifyProfileBatches({ control, controlDB, service, db, jwt }) {
  const profiles = Array.from({ length: 93 }, (_, i) => ({
    id: (i + 1).toString(16).padStart(32, "0"), display_name: `Batch member ${i + 1}`,
  }));
  await controlDB.batch(profiles.map((profile) => controlDB.prepare(
    "INSERT INTO users(id,email,display_name,created_at) VALUES (?,?,?,1)",
  ).bind(profile.id, `${profile.id}@profile-batches.test`, profile.display_name)));
  await db.prepare("INSERT INTO lobbies VALUES ('profile-batches','members',?,NULL,1)").bind(profiles[0].id).run();
  await db.batch(profiles.map((profile) => db.prepare(
    "INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES ('profile-batches',?,'member',1)",
  ).bind(profile.id)));
  const headers = { Authorization: `Bearer ${jwt(profiles[0].id)}`, "Content-Type": "application/json" };
  const membersResponse = await service.fetch("https://service.test/api/lobbies/profile-batches/members", { headers });
  assert.equal(membersResponse.status, 200);
  const { members } = await membersResponse.json();
  const ids = members.map((member) => member.user_id);
  assert.equal(ids.length, 93);
  const requests = [];
  const statuses = [];
  const cache = createNameCache(async (user_ids) => {
    requests.push(user_ids);
    const response = await control.fetch("https://control.test/api/profiles/lookup", {
      method: "POST", headers, body: JSON.stringify({ user_ids }),
    });
    statuses.push(response.status);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    return body.profiles;
  });
  for (let poll = 0; poll < 3; poll++) await cache.ensure(ids);
  console.log(`profile batches: sizes=${requests.map((ids) => ids.length)}, statuses=${statuses}`);
  assert.deepEqual(statuses, [200, 200]);
  assert.deepEqual(requests.map((ids) => ids.length), [90, 3]);
  for (const profile of profiles) assert.equal(cache.get(profile.id), profile.display_name);
  console.log("PASS workerd: desktop name cache resolves the service member list in bounded control requests and does not repeat cached lookups");
}
