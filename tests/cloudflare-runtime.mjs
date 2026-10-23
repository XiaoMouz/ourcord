// Local-only workerd integration: no Cloudflare account or production resources.
// Uses the Miniflare version already installed with control's pinned Wrangler.
import { verifyPresenceRetirement } from "./cloudflare-presence-cost.mjs";
import assert from "node:assert/strict";
import { verifyErrorBoundaries } from "./cloudflare-error-boundaries.mjs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { verifyPresenceIndex } from "./cloudflare-presence-index.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createHmac } from "node:crypto";
import { verifyExternalUploadFinalization } from "./cloudflare-external-uploads.mjs";
import { verifyRoomReorder } from "./cloudflare-room-reorder.mjs";
import { verifyInternalReplay } from "./cloudflare-internal-replay.mjs";
import { verifyProfileNameLimit } from "./cloudflare-profile-limits.mjs";
import { verifyFileListScan } from "./cloudflare-file-list.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, "control/package.json"));
const wranglerRequire = createRequire(require.resolve("wrangler"));
const { Miniflare } = wranglerRequire("miniflare");
const output = mkdtempSync(join(tmpdir(), "ourcord-runtime-"));
const secret = "local-runtime-test-secret";
const limits = Object.fromEntries([5, 10, 20, 30, 60, 120].map((n) => [
  `RATE_LIMIT_${n}`, { simple: { limit: n, period: 60 } },
]));
let mf;
const sockets = [];

function sqlStatements(sql) {
  const statements = [];
  let pending = "";
  for (const part of sql.replace(/^\s*--.*$/gm, "").split(";")) {
    pending += part;
    if (/^\s*CREATE TRIGGER\b/i.test(pending) && !/\bEND\s*$/i.test(pending)) {
      pending += ";";
      continue;
    }
    if (pending.trim()) statements.push(pending.trim());
    pending = "";
  }
  return statements;
}

async function migrate(db, module) {
  const directory = join(root, module, "migrations");
  for (const file of readdirSync(directory).filter((f) => f.endsWith(".sql")).sort()) {
    const statements = sqlStatements(readFileSync(join(directory, file), "utf8"));
    await db.batch(statements.map((sql) => db.prepare(sql)));
  }
}

function jwt(sub = "u1") {
  const data = Buffer.from(JSON.stringify({ sub, email: "test@example.test", iat: 1, exp: 9999999999 })).toString("base64url");
  return `${data}.${createHmac("sha256", secret).update(data).digest("base64url")}`;
}

try {
  for (const module of ["control", "service"]) {
    const moduleRequire = createRequire(join(root, module, "package.json"));
    const manifestPath = moduleRequire.resolve("wrangler/package.json");
    const manifest = moduleRequire("wrangler/package.json");
    const cli = join(dirname(manifestPath), manifest.bin.wrangler);
    execFileSync(process.execPath, [cli, "deploy", "--dry-run", "--outdir", join(output, module)], {
      cwd: join(root, module), stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
  }
  writeFileSync(join(output, "service/room-append-race.mjs"),
    readFileSync(join(root, "tests/cloudflare-room-append-worker.mjs"), "utf8"));
  writeFileSync(join(output, "service/presence-cost.mjs"),
    readFileSync(join(root, "tests/cloudflare-presence-cost-worker.mjs"), "utf8"));
  writeFileSync(join(output, "service/service-under-test.mjs"),
    readFileSync(join(output, "service/index.js"), "utf8"));
  writeFileSync(join(output, "service/presence-index.mjs"),
    readFileSync(join(root, "tests/cloudflare-presence-index-worker.mjs"), "utf8"));
  writeFileSync(join(output, "service/file-list.mjs"),
    readFileSync(join(root, "tests/cloudflare-file-list-worker.mjs"), "utf8"));
  mf = new Miniflare({
    cf: false,
    workers: [...["control", "service"].map((name) => ({
      name, modules: true, modulesRoot: join(output, name), scriptPath: join(output, name, "index.js"),
      compatibilityDate: "2024-01-01", compatibilityFlags: ["nodejs_compat"],
      bindings: { ENVIRONMENT: "production", JWT_SECRET: secret, SERVICE_INTERNAL_TOKEN: secret, R2_MAX_BYTES: "10485760", R2_MAX_FILES: "2" },
      d1Databases: { DB: `local-${name}` }, kvNamespaces: ["KV"], ratelimits: limits,
      ...(name === "control"
        ? { durableObjects: { SIGNAL: { className: "SignalDO", useSQLite: true } } }
        : { r2Buckets: ["FILES"] }),
    })), {
      name: "service-file-list", modules: true, modulesRoot: join(output, "service"),
      scriptPath: join(output, "service/file-list.mjs"),
      compatibilityDate: "2024-01-01", compatibilityFlags: ["nodejs_compat"],
      bindings: { ENVIRONMENT: "production", JWT_SECRET: secret },
      d1Databases: { DB: "local-service" },
    }, {
      name: "service-presence-cost", modules: true, modulesRoot: join(output, "service"),
      scriptPath: join(output, "service/presence-cost.mjs"),
      compatibilityDate: "2024-01-01", compatibilityFlags: ["nodejs_compat"],
      bindings: { ENVIRONMENT: "production", JWT_SECRET: secret },
      d1Databases: { DB: "local-service" },
    }, {
      name: "service-room-append-race", modules: true, modulesRoot: join(output, "service"),
      scriptPath: join(output, "service/room-append-race.mjs"),
      compatibilityDate: "2024-01-01", compatibilityFlags: ["nodejs_compat"],
      bindings: { ENVIRONMENT: "production", JWT_SECRET: secret },
      d1Databases: { DB: "local-service" }, ratelimits: limits,
    }, {
      name: "service-presence-index", modules: true, modulesRoot: join(output, "service"),
      scriptPath: join(output, "service/presence-index.mjs"),
      compatibilityDate: "2024-01-01", compatibilityFlags: ["nodejs_compat"],
      bindings: { ENVIRONMENT: "production", JWT_SECRET: secret },
      d1Databases: { DB: "local-service" }, ratelimits: limits,
    }],
  });
  const db = await mf.getD1Database("DB", "service");
  await migrate(db, "service");
  await db.batch([
    db.prepare("INSERT INTO lobbies VALUES ('L1','test','u1',NULL,1)"),
    db.prepare("INSERT INTO rooms(id,lobby_id,name) VALUES ('R1','L1','files'), ('R2','L1','general')"),
    db.prepare("INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES ('L1','u1','owner',1)"),
    db.prepare("INSERT INTO file_policies(lobby_id,max_temp_files,user_server_enabled,lobby_server_enabled) VALUES ('L1',0,0,0)"),
  ]);
  const service = await mf.getWorker("service");
  await verifyFileListScan({ db, service, metered: await mf.getWorker("service-file-list"), jwt });
  await verifyPresenceIndex({ db, service: await mf.getWorker("service-presence-index"), jwt });
  await verifyInternalReplay({ service, db, secret });
  await verifyRoomReorder({ service, db, jwt });
  const call = (path, method = "GET", body) => service.fetch(`https://service.test${path}`, {
    method, headers: { Authorization: `Bearer ${jwt()}`, "Content-Type": "application/json" }, body,
  });
  await db.batch([
    db.prepare("INSERT INTO lobbies VALUES ('Ldelete','deletion race','u1',NULL,1)"),
    db.prepare("INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES ('Ldelete','u1','owner',1)"),
    db.prepare("INSERT INTO rooms(id,lobby_id,name) VALUES ('Rdelete1','Ldelete','one'), ('Rdelete2','Ldelete','two')"),
  ]);
  const deletions = await Promise.all(["Rdelete1", "Rdelete2"].map((id) => call(`/api/rooms/${id}`, "DELETE")));
  assert.deepEqual(deletions.map((response) => response.status).sort(), [200, 400]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM rooms WHERE lobby_id = 'Ldelete'").first()).n, 1);
  console.log("PASS workerd: concurrent owner room deletion preserves the last room");
  await db.prepare("INSERT INTO rooms(id,lobby_id,name,position) VALUES ('Rpatch','L1','original',0)").run();
  // Deterministically inject a rename after the handler's SELECT but before
  // its position write. A full-row write would overwrite this intervening edit.
  await db.prepare(`CREATE TRIGGER test_room_patch_interleaving BEFORE UPDATE OF position ON rooms
    WHEN OLD.id = 'Rpatch'
    BEGIN UPDATE rooms SET name = 'renamed' WHERE id = OLD.id; END`).run();
  const reordered = await call("/api/rooms/Rpatch", "PATCH", JSON.stringify({ position: 7 }));
  assert.equal(reordered.status, 200);
  const reorderedRoom = await reordered.json();
  assert.equal(reorderedRoom.name, "renamed");
  assert.equal(reorderedRoom.position, 7);
  assert.deepEqual(
    await db.prepare("SELECT name,position FROM rooms WHERE id = 'Rpatch'").first(),
    { name: "renamed", position: 7 },
  );
  await db.prepare("DROP TRIGGER test_room_patch_interleaving").run();
  const renamed = await call("/api/rooms/Rpatch", "PATCH", JSON.stringify({ name: "final" }));
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).position, 7);
  const unchanged = await call("/api/rooms/Rpatch", "PATCH", "{}");
  assert.equal(unchanged.status, 200);
  assert.equal((await unchanged.json()).name, "final");
  assert.equal((await call("/api/rooms/Rpatch", "DELETE")).status, 200);
  console.log("PASS workerd: partial room PATCH preserves intervening edits and returns stored values");
  await db.batch([
    db.prepare("INSERT INTO lobbies VALUES ('Lappend','append race','u1',NULL,1)"),
    db.prepare("INSERT INTO lobby_members(lobby_id,user_id,role,joined_at) VALUES ('Lappend','u1','owner',1), ('Lappend','u2','admin',1)"),
    db.prepare("INSERT INTO rooms(id,lobby_id,name,position) VALUES ('Rappend','Lappend','general',0)"),
  ]);
  let lastAppendPosition = 0;
  const roomAppendService = await mf.getWorker("service-room-append-race");
  for (const type of ["text", "voice"]) {
    const responses = await Promise.all(["u1", "u2"].map((user) => roomAppendService.fetch("https://service.test/api/lobbies/Lappend/rooms", {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt(user)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: `${type}-${user}`, type }),
    })));
    assert.deepEqual(responses.map((response) => response.status), [201, 201]);
    const rooms = await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(rooms.map((room) => room.position).sort((a, b) => a - b),
      [lastAppendPosition + 1, lastAppendPosition + 2]);
    for (const room of rooms) {
      assert.equal((await db.prepare("SELECT position FROM rooms WHERE id = ?").bind(room.id).first()).position, room.position);
      if (type === "voice") assert.equal(room.vpn_namespace, `lobby-Lappend-${room.id}-voice`);
      else assert.equal(room.vpn_namespace, undefined);
    }
    lastAppendPosition += 2;
  }
  const explicitRoom = await call("/api/lobbies/Lappend/rooms", "POST",
    JSON.stringify({ name: "explicit", type: "text", position: 0 }));
  assert.equal(explicitRoom.status, 201);
  assert.equal((await explicitRoom.json()).position, 0);
  console.log("PASS workerd: concurrent room appends return distinct stored positions; explicit zero remains supported");
  await db.prepare("INSERT INTO rooms(id,lobby_id,name) VALUES ('Rlimits','L1','limits')").run();
  await db.batch(Array.from({ length: 105 }, (_, index) => db.prepare(
    "INSERT INTO messages(id,room_id,user_id,content,created_at) VALUES (?, 'Rlimits', 'u1', 'page bound', 100)"
  ).bind(`page-bound-${index}`)));
  for (const [query, expected] of [["", 50], ["?limit=1", 1], ["?limit=100", 100], ["?limit=101", 100]]) {
    const response = await call(`/api/rooms/Rlimits/messages${query}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).messages.length, expected);
  }
  for (const limit of ["-1", "0", "NaN", "1.5", "", "1e3", "3abc", "9007199254740992"]) {
    const response = await call(`/api/rooms/Rlimits/messages?limit=${encodeURIComponent(limit)}`);
    assert.equal(response.status, 400, `invalid limit ${JSON.stringify(limit)} must not query unbounded history`);
  }
  console.log("PASS workerd: default and capped message pages, invalid limits rejected");
  const historyIDs = Array.from({ length: 105 }, (_, index) => `message-${String(index).padStart(3, "0")}`);
  await db.batch(historyIDs.map((id) => db.prepare(
    "INSERT INTO messages(id,room_id,user_id,content,created_at) VALUES (?, 'R2', 'u1', 'same second', 100)"
  ).bind(id)));
  await db.batch([
    db.prepare("INSERT INTO messages(id,room_id,user_id,content,created_at) VALUES ('older', 'R2', 'u1', 'older', 99)"),
    db.prepare("INSERT INTO messages(id,room_id,user_id,content,created_at) VALUES ('foreign', 'R1', 'u1', 'foreign', 101)"),
  ]);
  let history = [];
  let cursor = "";
  for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
    const response = await call(`/api/rooms/R2/messages?limit=50${cursor ? `&before=${cursor}` : ""}`);
    assert.equal(response.status, 200);
    const page = (await response.json()).messages;
    assert(page.length <= 50, "message pages must honor the requested limit");
    if (page.length === 0) break;
    history = [...page.map((message) => message.id), ...history];
    cursor = page[0].id;
  }
  assert.deepEqual(history, ["older", ...historyIDs]);
  for (const invalidCursor of ["foreign", "missing"]) {
    const response = await call(`/api/rooms/R2/messages?before=${invalidCursor}`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).messages, []);
  }
  console.log("PASS workerd: same-second message pagination, chronological ordering and room-scoped cursors");
  await db.prepare("INSERT INTO rooms(id,lobby_id,name) VALUES ('Rindex','L1','index bounds')").run();
  const burstIDs = Array.from({ length: 120 }, (_, i) => `burst-${String(i).padStart(3, "0")}`);
  await db.batch(burstIDs.map((id) => db.prepare(
    "INSERT INTO messages(id,room_id,user_id,content,created_at) VALUES (?,'Rindex','u1','burst',100)",
  ).bind(id)));
  // Measure the history SQL separately from authorization reads. The SQLite
  // query-plan tests also inspect the actual handler's generated statements.
  const historyQueries = [
    ["", "SELECT * FROM messages WHERE room_id = ? ORDER BY created_at DESC, id DESC LIMIT ?", ["Rindex", 50], 70],
    ["?before=burst-060&before_created_at=100", "SELECT * FROM messages WHERE room_id = ? AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?", ["Rindex", 100, "burst-060", 50], 10],
    ["?before=burst-060", "SELECT * FROM messages WHERE room_id = ? AND (created_at, id) < ((SELECT created_at FROM messages WHERE id = ? AND room_id = ?), ?) ORDER BY created_at DESC, id DESC LIMIT ?", ["Rindex", "burst-060", "Rindex", "burst-060", 50], 10],
  ];
  for (const [query, sql, params, start] of historyQueries) {
    const result = await db.prepare(sql).bind(...params).all();
    console.log(`D1 history ${query || "latest"}: ${result.meta.rows_read} rows read for ${result.results.length} results`);
    assert(result.meta.rows_read <= 55, "a 50-message page must seek through the full cursor index");
    assert.deepEqual(result.results.map((message) => message.id).reverse(), burstIDs.slice(start, start + 50));
    const response = await call(`/api/rooms/Rindex/messages${query}`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).messages.map((message) => message.id), burstIDs.slice(start, start + 50));
  }
  assert.equal((await call("/api/rooms/Rindex", "DELETE")).status, 200);
  console.log("PASS workerd: same-second message pages use bounded D1 reads and match API ordering");
  const cursorPage = await (await call("/api/rooms/R2/messages?limit=50")).json();
  const boundaryMessage = cursorPage.messages[0];
  assert.equal(boundaryMessage.id, historyIDs[55]);
  assert.equal((await call(`/api/rooms/R2/messages/${boundaryMessage.id}`, "DELETE")).status, 200);
  const afterDeletion = await call(`/api/rooms/R2/messages?limit=50&before=${boundaryMessage.id}&before_created_at=${boundaryMessage.created_at}`);
  assert.equal(afterDeletion.status, 200);
  const olderAfterDeletion = (await afterDeletion.json()).messages;
  assert.deepEqual(olderAfterDeletion.map((message) => message.id), historyIDs.slice(5, 55));
  const tailBoundary = olderAfterDeletion[0];
  const historyTail = await call(`/api/rooms/R2/messages?limit=50&before=${tailBoundary.id}&before_created_at=${tailBoundary.created_at}`);
  assert.deepEqual((await historyTail.json()).messages.map((message) => message.id), ["older", ...historyIDs.slice(0, 5)]);
  for (const timestamp of ["-1", "1.5", "9007199254740992"]) {
    assert.equal((await call(`/api/rooms/R2/messages?before=${boundaryMessage.id}&before_created_at=${timestamp}`)).status, 400);
  }
  console.log("PASS workerd: deleted message cursor retains older history, including same-second boundaries and page limits");
  const initiated = await call("/api/rooms/R1/files", "POST", JSON.stringify({
    filename: "smoke.bin", size_bytes: 1024 * 1024, mime_type: "application/octet-stream",
  }));
  assert.equal(initiated.status, 201, await initiated.clone().text());
  const file = await initiated.json();
  const uploads = await Promise.all([1, 2].map(() => call(file.upload_url, "PUT", new Uint8Array(1024 * 1024))));
  assert.deepEqual(uploads.map((r) => r.status).sort(), [200, 409]);
  const r2 = await mf.getR2Bucket("FILES", "service");
  assert.equal((await r2.head(file.storage_key)).size, 1024 * 1024);
  const downloaded = await call(`/api/rooms/R1/files/${file.id}/download`);
  assert.equal(downloaded.status, 200);
  assert.equal((await downloaded.arrayBuffer()).byteLength, 1024 * 1024);
  assert.equal((await call("/api/rooms/R1", "DELETE")).status, 200);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM r2_deletion_queue").first()).n, 1);
  assert.equal((await db.prepare("SELECT reserved_files FROM r2_usage").first()).reserved_files, 1);
  // Simulate the grace period elapsing, then invoke the actual cron handler.
  await db.prepare("UPDATE r2_deletion_queue SET not_before = 0").run();
  await service.scheduled({ scheduledTime: Date.now(), cron: "0 * * * *" });
  assert.equal(await r2.head(file.storage_key), null);
  assert.equal((await db.prepare("SELECT reserved_files FROM r2_usage").first()).reserved_files, 0);
  console.log("PASS workerd: D1 migrations, atomic reservation/PUT, FixedLengthStream, R2 download and cascade cleanup");

  const makeInvite = async (maxUses = 1) => {
    const response = await call("/api/lobbies/L1/invites", "POST", JSON.stringify({ max_uses: maxUses }));
    assert.equal(response.status, 201);
    return (await response.json()).code;
  };
  const redeem = (code, user) => service.fetch("https://service.test/api/lobbies/L1/join", {
    method: "POST", headers: { Authorization: `Bearer ${jwt(user)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const inviteUses = (code) => db.prepare("SELECT uses FROM lobby_invites WHERE code = ?").bind(code).first("uses");
  const singleUse = await makeInvite();
  const sameUser = await Promise.all([redeem(singleUse, "invite-guest"), redeem(singleUse, "invite-guest")]);
  assert.deepEqual(sameUser.map((response) => response.status), [200, 200]);
  assert.equal(await inviteUses(singleUse), 1);
  assert.equal((await redeem(singleUse, "different-guest")).status, 403);
  const raceInvite = await makeInvite();
  const distinctUsers = await Promise.all([redeem(raceInvite, "race-guest-1"), redeem(raceInvite, "race-guest-2")]);
  assert.deepEqual(distinctUsers.map((response) => response.status).sort(), [200, 403]);
  assert.equal(await inviteUses(raceInvite), 1);

  const retryInvite = await makeInvite();
  await db.prepare(`CREATE TRIGGER fail_test_membership BEFORE INSERT ON lobby_members
    WHEN NEW.user_id = 'retry-guest'
    BEGIN SELECT RAISE(ABORT, 'injected membership failure'); END`).run();
  let writeFailed = false;
  try {
    writeFailed = (await redeem(retryInvite, "retry-guest")).status >= 500;
  } catch (error) {
    assert.match(String(error), /injected membership failure/);
    writeFailed = true;
  }
  assert(writeFailed, "the injected D1 failure must reach the caller");
  assert.equal(await inviteUses(retryInvite), 0);
  assert.equal(await db.prepare("SELECT user_id FROM lobby_members WHERE user_id = 'retry-guest'").first(), null);
  await db.prepare("DROP TRIGGER fail_test_membership").run();
  assert.equal((await redeem(retryInvite, "retry-guest")).status, 200);
  assert.equal(await inviteUses(retryInvite), 1);
  const rollbackInvite = await makeInvite();
  await db.prepare(`CREATE TRIGGER fail_test_consumption BEFORE UPDATE ON lobby_invites
    BEGIN SELECT RAISE(ABORT, 'injected consumption failure'); END`).run();
  let consumptionFailed = false;
  try {
    consumptionFailed = (await redeem(rollbackInvite, "rollback-guest")).status >= 500;
  } catch (error) {
    assert.match(String(error), /injected consumption failure/);
    consumptionFailed = true;
  }
  assert(consumptionFailed, "the second statement must fail in this test");
  assert.equal(await inviteUses(rollbackInvite), 0);
  assert.equal(await db.prepare("SELECT user_id FROM lobby_members WHERE user_id = 'rollback-guest'").first(), null);
  await db.prepare("DROP TRIGGER fail_test_consumption").run();
  assert.equal((await redeem(rollbackInvite, "rollback-guest")).status, 200);
  console.log("PASS workerd: transactional invite redemption, duplicate accounts, quota and retry after D1 write failure");

  const controlDB = await mf.getD1Database("DB", "control");
  await migrate(controlDB, "control");
  const control = await mf.getWorker("control");
  await verifyErrorBoundaries({ mf, service, db, controlDB, jwt });
  await verifyProfileNameLimit({ control, controlDB, jwt });
  const kv = await mf.getKVNamespace("KV", "control");
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const magicToken = "d".repeat(64);
  // Seed the emailed capability locally; the browser confirmation, D1 insert,
  // cron and PKCE exchange below all run through the actual Worker.
  const confirmLogin = async () => {
    await kv.put(`desktop_magic:${createHash("sha256").update(magicToken).digest("base64url")}`,
      JSON.stringify({ email: "cleanup@example.test", challenge }), { expirationTtl: 600 });
    const confirmed = await control.fetch("https://control.test/api/auth/desktop/magic/confirm", {
      method: "POST", redirect: "manual", body: new URLSearchParams({ token: magicToken }),
    });
    assert.equal(confirmed.status, 303);
    return new URL(confirmed.headers.get("Location")).searchParams.get("code");
  };
  await confirmLogin();
  await controlDB.prepare("UPDATE desktop_auth_codes SET expires_at = 1").run();
  await control.scheduled({ scheduledTime: Date.now(), cron: "0 * * * *" });
  assert.equal(await controlDB.prepare("SELECT COUNT(*) FROM desktop_auth_codes").first("COUNT(*)"), 0);
  const activeCode = await confirmLogin();
  const codeOwner = await controlDB.prepare("SELECT id FROM users WHERE email = 'cleanup@example.test'").first("id");
  for (let start = 0; start < 505; start += 100) {
    await controlDB.batch(Array.from({ length: Math.min(100, 505 - start) }, (_, offset) =>
      controlDB.prepare("INSERT INTO desktop_auth_codes VALUES (?, ?, 'cleanup@example.test', ?, 1)")
        .bind(`expired-${start + offset}`, codeOwner, challenge)));
  }
  await control.scheduled({ scheduledTime: Date.now(), cron: "0 * * * *" });
  assert.equal(await controlDB.prepare("SELECT COUNT(*) FROM desktop_auth_codes").first("COUNT(*)"), 6);
  const exchangeLogin = () => control.fetch("https://control.test/api/auth/desktop/exchange", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: activeCode, code_verifier: verifier }),
  });
  assert.equal((await exchangeLogin()).status, 200);
  assert.equal((await exchangeLogin()).status, 401);
  await control.scheduled({ scheduledTime: Date.now(), cron: "0 * * * *" });
  assert.equal(await controlDB.prepare("SELECT COUNT(*) FROM desktop_auth_codes").first("COUNT(*)"), 0);
  console.log("PASS workerd: abandoned desktop codes cleaned in bounded batches; valid PKCE exchange remains one-time");
  // This public endpoint ordinarily executes four D1 queries. Once blocked,
  // the native limiter rejects it before any queries or KV counters.
  const statuses = [];
  for (let i = 0; i < 65; i++) {
    statuses.push((await control.fetch("https://control.test/api/control/status")).status);
  }
  assert(statuses.includes(200));
  assert(statuses.includes(429));
  assert.equal((await kv.list({ prefix: "ratelimit:" })).keys.length, 0);
  console.log("PASS workerd: native rate limiter returns 429 without KV writes");

  const confirmationURL = "https://control.test/api/auth/desktop/magic/confirm";
  const confirmationCall = (token, ip = "192.0.2.10") => control.fetch(confirmationURL, {
    method: "POST", redirect: "manual", headers: { "CF-Connecting-IP": ip },
    body: new URLSearchParams({ token }),
  });
  const confirmationStatuses = [];
  for (let i = 0; i < 32; i++) {
    confirmationStatuses.push((await confirmationCall(i.toString(16).padStart(64, "0"))).status);
  }
  assert(confirmationStatuses.includes(400));
  assert(confirmationStatuses.includes(429), "random confirmation tokens must encounter the native storage gate");
  const confirmationToken = "e".repeat(64);
  const confirmationVerifier = "w".repeat(43);
  const confirmationKey = `desktop_magic:${createHash("sha256").update(confirmationToken).digest("base64url")}`;
  const pendingCapability = JSON.stringify({
    email: "confirmation@example.test",
    challenge: createHash("sha256").update(confirmationVerifier).digest("base64url"),
  });
  await kv.put(confirmationKey, pendingCapability, { expirationTtl: 600 });
  const blockedConfirmation = await confirmationCall(confirmationToken);
  assert.equal(blockedConfirmation.status, 429);
  assert.equal(blockedConfirmation.headers.get("Retry-After"), "60");
  assert.equal(await kv.get(confirmationKey), pendingCapability, "throttling must not consume a valid pending login");
  const preview = await control.fetch(`${confirmationURL}?token=${confirmationToken}`, {
    headers: { "CF-Connecting-IP": "192.0.2.10" },
  });
  assert.equal(preview.status, 200);
  assert.equal(await kv.get(confirmationKey), pendingCapability);
  const allowedConfirmation = await confirmationCall(confirmationToken, "192.0.2.11");
  assert.equal(allowedConfirmation.status, 303);
  assert.equal(await kv.get(confirmationKey), null);
  const confirmedCode = new URL(allowedConfirmation.headers.get("Location")).searchParams.get("code");
  const exchangedConfirmation = await control.fetch("https://control.test/api/auth/desktop/exchange", {
    method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "192.0.2.11" },
    body: JSON.stringify({ code: confirmedCode, code_verifier: confirmationVerifier }),
  });
  assert.equal(exchangedConfirmation.status, 200);
  console.log("PASS workerd: confirmation probes limited, blocked token preserved, preview and valid PKCE login succeed");

  const namespace = await mf.getDurableObjectNamespace("SIGNAL", "control");
  const room = namespace.get(namespace.idFromName("runtime-smoke"));
  async function connect(pk) {
    const response = await room.fetch(`https://signal.test/?pk=${pk}`, { headers: { Upgrade: "websocket" } });
    assert.equal(response.status, 101);
    const ws = response.webSocket;
    const messages = [];
    ws.addEventListener("message", (event) => messages.push(JSON.parse(event.data)));
    ws.accept();
    sockets.push(ws);
    return { ws, messages };
  }
  async function until(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      assert(Date.now() < deadline, "timed out waiting for WebSocket event");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const alice = await connect("alice");
  alice.ws.send(JSON.stringify({ type: "offer", to: "bob", payload: "replay-me" }));
  alice.ws.send(JSON.stringify({ type: "ping" }));
  await until(() => alice.messages.some((m) => m.type === "pong"));
  const bob = await connect("bob");
  await until(() => bob.messages.some((m) => m.type === "offer" && m.payload === "replay-me"));
  const replacement = await connect("alice");
  replacement.ws.send(JSON.stringify({ type: "candidate", to: "bob", payload: "new-session" }));
  await until(() => bob.messages.some((m) => m.payload === "new-session"));
  // Hibernation itself is covered by constructor reconstruction tests; this
  // verifies native attachments, SQLite storage and runtime event callbacks.
  console.log("PASS workerd: hibernatable WebSocket handshake, replay and replacement connection");

  // A JSON document is file data, even when it contains a property named url.
  // The desktop bridge relies on Content-Disposition to distinguish this
  // response from the external-backend JSON download descriptor.
  const jsonContent = JSON.stringify({ url: "https://example.invalid/file-data", configuration: true });
  const jsonInitiated = await call("/api/rooms/R2/files", "POST", JSON.stringify({
    filename: "config.json", size_bytes: Buffer.byteLength(jsonContent), mime_type: "application/json",
  }));
  assert.equal(jsonInitiated.status, 201);
  const jsonFile = await jsonInitiated.json();
  assert.equal((await call(jsonFile.upload_url, "PUT", jsonContent)).status, 200);
  const jsonDownloaded = await call(`/api/rooms/R2/files/${jsonFile.id}/download`);
  assert.equal(jsonDownloaded.status, 200);
  assert.equal(jsonDownloaded.headers.get("Content-Type"), "application/json");
  assert.match(jsonDownloaded.headers.get("Content-Disposition"), /^attachment;/);
  assert.equal(await jsonDownloaded.text(), jsonContent);
  console.log("PASS workerd: R2 JSON attachments retain their bytes and attachment disposition");
  await verifyExternalUploadFinalization(db, call, service);
  await verifyPresenceRetirement({ db, service: await mf.getWorker("service-presence-cost"), jwt });
} finally {
  for (const ws of sockets) { try { ws.close(1000, "test complete"); } catch {} }
  await mf?.dispose();
  rmSync(output, { recursive: true, force: true });
}
