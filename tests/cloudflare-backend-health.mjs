import assert from "node:assert/strict";

export async function verifyBackendHealthScan({ db, worker }) {
  // A shared registry can grow across many small, independent user groups.
  await db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 5000)
    INSERT INTO file_backends(id,owner_id,base_url,created_at,health_status,last_health_at)
    SELECT 'health-'||i, 'owner-'||i, 'https://health-'||i||'.test', 1,
      CASE i%3 WHEN 0 THEN 'healthy' WHEN 1 THEN 'unknown' ELSE 'unhealthy' END, i FROM n`).run();
  await db.prepare(`INSERT INTO file_backends(id,owner_id,base_url,created_at,active,last_health_at)
    VALUES ('health-inactive','owner','https://inactive.test',1,0,NULL),
           ('health-never','owner','https://never.test',1,1,NULL)`).run();
  const first = await (await worker.fetch("https://cron.test/")).json();
  console.log(`backend health selection: reads=${first.selections[0].reads}, writes=${first.writes}`);
  assert.deepEqual(first.selections[0].ids, ["health-never", ...Array.from({ length: 49 }, (_, i) => `health-${i + 1}`)]);
  assert.ok(first.selections[0].reads <= 200, `50 probes selected by reading ${first.selections[0].reads} rows`);
  assert.equal(first.writes, 100, "selection must not add per-probe index writes");
  const second = await (await worker.fetch("https://cron.test/")).json();
  assert.deepEqual(second.selections[0].ids, Array.from({ length: 50 }, (_, i) => `health-${i + 50}`));
  assert.ok(second.selections[0].reads <= 200);
  assert.equal(second.writes, first.writes);
  assert.equal((await db.prepare("SELECT last_health_at FROM file_backends WHERE id='health-inactive'").first()).last_health_at, null);
  await db.prepare("DELETE FROM file_backends WHERE id LIKE 'health-%'").run();
  console.log("PASS workerd: hourly backend checks select bounded oldest batches across statuses and skip inactive backends");
}
