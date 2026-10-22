// Local-only workerd integration: no Cloudflare account or production resources.
// Uses the Miniflare version already installed with control's pinned Wrangler.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";

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
  mf = new Miniflare({
    cf: false,
    workers: ["control", "service"].map((name) => ({
      name, modules: true, modulesRoot: join(output, name), scriptPath: join(output, name, "index.js"),
      compatibilityDate: "2024-01-01", compatibilityFlags: ["nodejs_compat"],
      bindings: { ENVIRONMENT: "production", JWT_SECRET: secret, R2_MAX_BYTES: "10485760", R2_MAX_FILES: "2" },
      d1Databases: { DB: `local-${name}` }, kvNamespaces: ["KV"], ratelimits: limits,
      ...(name === "control"
        ? { durableObjects: { SIGNAL: { className: "SignalDO", useSQLite: true } } }
        : { r2Buckets: ["FILES"] }),
    })),
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
  // This public endpoint ordinarily executes four D1 queries. Once blocked,
  // the native limiter rejects it before any queries or KV counters.
  const statuses = [];
  for (let i = 0; i < 65; i++) {
    statuses.push((await control.fetch("https://control.test/api/control/status")).status);
  }
  assert(statuses.includes(200));
  assert(statuses.includes(429));
  const kv = await mf.getKVNamespace("KV", "control");
  assert.equal((await kv.list({ prefix: "ratelimit:" })).keys.length, 0);
  console.log("PASS workerd: native rate limiter returns 429 without KV writes");

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
} finally {
  for (const ws of sockets) { try { ws.close(1000, "test complete"); } catch {} }
  await mf?.dispose();
  rmSync(output, { recursive: true, force: true });
}
