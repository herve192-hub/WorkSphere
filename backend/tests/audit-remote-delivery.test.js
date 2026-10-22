const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { randomBytes, randomUUID } = require("node:crypto");
const { gzipSync } = require("node:zlib");
const { spawn, execFile } = require("node:child_process");
const { once } = require("node:events");
const { promisify } = require("node:util");
const path = require("node:path");
const mongoose = require("mongoose");
const { MongoClient } = mongoose.mongo;
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const jwt = require("jsonwebtoken");
const { createAuditOutbox, createAuditWorker } = require("../src/outbox");
const { createAuditHttpDelivery } = require("../src/outbox/httpDelivery");
const { loadAuditWorkerConfig } = require("../src/outbox/workerConfig");
const { ISSUER, AUDIENCE } = require("../src/contracts/auditService");

const run = promisify(execFile);
const backend = path.resolve(__dirname, "..");
const businessName = "remote_producer", auditName = "remote_audit";
const actorId = "abcdefabcdefabcdefabcdef", resourceId = "123456789012345678901234";
const keys = Object.fromEntries(["employees", "identity", "api"].map((name) => [name, randomBytes(32).toString("hex")]));
const passwords = Object.fromEntries(["root", "producer", "receiver"].map((name) => [name, randomBytes(32).toString("hex")]));
const children = new Set();
let mongo, root, business, audit, db, history, service;

function uri(user, database) {
  const url = new URL(mongo.getUri(database));
  url.username = user; url.password = passwords[user]; url.searchParams.set("authSource", "admin");
  return url.href;
}
function workerEnv(url = service.endpoint) {
  return { ...process.env, MONGO_URI: uri("producer", businessName), JWT_ACCESS_SECRET: "",
    AUDIT_WORKER_TRANSPORT: "http", AUDIT_DELIVERY_MODE: "async", AUDIT_SERVICE_URL: url,
    AUDIT_EMPLOYEES_KEY: keys.employees, AUDIT_IDENTITY_KEY: keys.identity };
}
async function stop(child, signal = "SIGTERM") {
  if (!child || child.exitCode !== null || child.signalCode) { children.delete(child); return; }
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill("SIGKILL"), 16000);
  child.kill(signal);
  try { return await exited; } finally { clearTimeout(timer); children.delete(child); }
}
async function start(script, env, ready) {
  const child = spawn(process.execPath, [`scripts/${script}.js`], { cwd: backend, env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  child.output = "";
  child.stdout.on("data", (chunk) => { child.output = (child.output + chunk).slice(-20000); });
  child.stderr.on("data", (chunk) => { child.output = (child.output + chunk).slice(-20000); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Remote fixture startup timeout")); }, 20000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Remote fixture exited before readiness")); });
    child.stdout.on("data", () => {
      for (const line of child.output.split("\n")) {
        let entry; try { entry = JSON.parse(line); } catch { continue; }
        if (ready(entry)) { clearTimeout(timer); resolve(); return; }
      }
    });
  });
  return child;
}
async function startService(port = 0) {
  let endpoint;
  const child = await start("audit-service", { ...process.env, JWT_ACCESS_SECRET: "",
    AUDIT_MONGO_URI: uri("receiver", auditName), AUDIT_SERVICE_KEYS: JSON.stringify(keys),
    AUDIT_HOST: "127.0.0.1", AUDIT_PORT: String(port) }, (entry) => {
    if (entry.message !== "audit_service_ready") return false;
    endpoint = `http://127.0.0.1:${entry.port}`; return true;
  });
  child.endpoint = endpoint;
  return child;
}
async function cli(url = service.endpoint, overrides = {}) {
  return run(process.execPath, ["scripts/audit-worker.js", "--once"], {
    cwd: backend, env: { ...workerEnv(url), ...overrides }, timeout: 20000,
  });
}
async function enqueue(producer = "employees", id = resourceId) {
  const outbox = createAuditOutbox(db, producer); await outbox.initialize();
  const session = business.startSession();
  let event;
  try {
    await session.withTransaction(async () => {
      // A durable business marker and its outbox intent commit before HTTP work.
      await db.collection("business_markers").insertOne({ producer, marker: randomUUID() }, { session });
      event = await outbox.enqueue(producer === "employees" ? {
        action: "EMPLOYEE_UPDATED", actor: { id: actorId, firstName: "Jamie", lastName: "Morgan", email: "jamie@example.com", role: "ADMIN" },
        resource: { type: "EMPLOYEE", id, label: "EMP-000001" }, changes: [], requestId: "remote-delivery-test",
      } : { action: "AUTH_LOGIN_FAILED", actor: null, resource: { type: "ACCOUNT", id: null, label: "" }, requestId: "remote-delivery-test" }, { session });
    }, { writeConcern: { w: "majority" } });
  } finally { await session.endSession(); }
  return event;
}
const events = () => db.collection("employee_audit_outbox");
const forceReady = (event) => events().updateOne({ _id: event.eventId }, { $set: { availableAt: new Date(0), leaseUntil: new Date(0) } });
async function worker(url = service.endpoint, options = {}, timeoutMs) {
  const deliver = createAuditHttpDelivery({ url, producer: "employees", key: keys.employees, ...(timeoutMs ? { timeoutMs } : {}) });
  const instance = createAuditWorker(db, "employees", deliver, options);
  await instance.initialize(); return instance;
}
async function withServer(handler, callback) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => res.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { return await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
const json = (res, status, body, headers = {}) => res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
const acknowledgment = (event, overrides = {}) => ({ data: { eventId: event.eventId, producer: "employees", auditId: actorId, duplicate: false, ...overrides } });
async function forward(req) {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  return fetch(service.endpoint + "/internal/v1/events", { method: "POST", headers: {
    Authorization: req.headers.authorization, "Content-Type": "application/json",
  }, body: Buffer.concat(chunks), signal: AbortSignal.timeout(10000) });
}

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, auth: { enable: true,
    customRootName: "root", customRootPwd: passwords.root, keyfileContent: randomBytes(32).toString("hex") } } });
  root = new MongoClient(uri("root", "admin")); await root.connect();
  for (const [user, database] of [["producer", businessName], ["receiver", auditName]])
    await root.db("admin").command({ createUser: user, pwd: passwords[user], roles: [{ role: "readWrite", db: database }] });
  business = new MongoClient(uri("producer", businessName)); audit = new MongoClient(uri("receiver", auditName));
  await Promise.all([business.connect(), audit.connect()]); db = business.db(); history = audit.db().collection("auditevents");
  service = await startService();
});
beforeEach(async () => {
  for (const { name } of await db.listCollections().toArray()) await db.collection(name).deleteMany({});
  await history.deleteMany({}); await audit.db().collection("audit_request_budgets").deleteMany({});
  assert.equal(mongoose.connection.readyState, 0);
});
after(async () => {
  await Promise.all([...children].map((child) => stop(child)));
  await Promise.all([business?.close(), audit?.close(), root?.close()]);
  if (mongo) await mongo.stop();
});

test("HTTP configuration fails before database access and never prints supplied credentials", async () => {
  const valid = workerEnv();
  assert.equal(loadAuditWorkerConfig({}).transport, "local");
  for (const overrides of [{ AUDIT_WORKER_TRANSPORT: "" }, { AUDIT_WORKER_TRANSPORT: "remote" },
    { AUDIT_SERVICE_URL: undefined }, { AUDIT_SERVICE_URL: "ftp://127.0.0.1" },
    { AUDIT_SERVICE_URL: "http://user:never-log@127.0.0.1" }, { AUDIT_SERVICE_URL: "http://127.0.0.1/internal" },
    { AUDIT_SERVICE_URL: "http://127.0.0.1?key=never-log" }, { AUDIT_SERVICE_URL: "http://127.0.0.1#fragment" },
    { AUDIT_EMPLOYEES_KEY: undefined }, { AUDIT_EMPLOYEES_KEY: "replace-with-a-random-secret-longer-than-32-bytes" },
    { AUDIT_IDENTITY_KEY: keys.employees }, { JWT_ACCESS_SECRET: keys.identity }, { AUDIT_DELIVERY_MODE: "sync" }]) {
    assert.throws(() => loadAuditWorkerConfig({ ...valid, ...overrides }));
  }
  for (const options of [{ producer: "api" }, { timeoutMs: 0 }, { timeoutMs: 8001 }, { key: "short" }])
    assert.throws(() => createAuditHttpDelivery({ url: service.endpoint, producer: "employees", key: keys.employees, ...options }), TypeError);
  await assert.rejects(cli(service.endpoint, { MONGO_URI: "mongodb://never-log-user:never-log-password@127.0.0.1:1/private", AUDIT_IDENTITY_KEY: "" }), (error) => {
    assert.doesNotMatch(error.stdout + error.stderr, /never-log|mongodb:|Bearer/); return true;
  });
  assert.equal((await db.listCollections({ name: "auditevents" }).toArray()).length, 0);
});

test("the real worker command delivers both producers with business-only credentials and no local history", async () => {
  const employee = await enqueue(); await enqueue("identity");
  const { stdout, stderr } = await cli(); assert.equal(stderr, "");
  const results = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(results[0].transport, "http");
  assert.equal(results.filter((result) => result.status === "DELIVERED").length, 2);
  assert.equal((await events().findOne({ _id: employee.eventId })).status, "DELIVERED");
  assert.equal(await history.countDocuments(), 2);
  assert.equal((await db.listCollections({ name: "auditevents" }).toArray()).length, 0);
  await assert.rejects(business.db(auditName).collection("auditevents").findOne(), { code: 13 });
  await assert.rejects(audit.db(businessName).collection("employee_audit_outbox").findOne(), { code: 13 });
  assert.ok(Object.values(keys).every((key) => !stdout.includes(key)));
});

test("each request signs the configured producer with bounded claims and validates ACK identity", async () => {
  const event = await enqueue();
  await withServer(async (req, res) => {
    assert.equal(req.url, "/internal/v1/events"); assert.equal(req.headers["x-request-id"], event.requestId);
    const claims = jwt.verify(req.headers.authorization.slice(7), keys.employees,
      { algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE, subject: "employees" });
    assert.equal(claims.exp - claims.iat, 60); assert.equal(claims.role, undefined); assert.equal(claims.actorId, undefined);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks)), event);
    json(res, 201, acknowledgment(event));
  }, async (url) => {
    const deliver = createAuditHttpDelivery({ url, producer: "employees", key: keys.employees });
    assert.deepEqual(await deliver(event, { producer: "employees" }), { auditId: actorId, duplicate: false });
    await assert.rejects(deliver(event, { producer: "identity" }), TypeError);
  });
});

test("receiver outage preserves committed business intent and recovers after the service restarts", async () => {
  const endpoint = service.endpoint, port = Number(new URL(endpoint).port);
  await stop(service);
  try {
    const event = await enqueue(); const instance = await worker(endpoint);
    assert.equal(await db.collection("business_markers").countDocuments(), 1);
    assert.equal((await instance.deliverNext()).status, "RETRY");
    assert.deepEqual((await events().findOne()).event, event);
    assert.equal(await history.countDocuments(), 0);
    service = await startService(port);
    await forceReady(event);
    assert.equal((await instance.deliverNext()).status, "DELIVERED");
    assert.equal(await history.countDocuments(), 1);
    assert.equal((await db.listCollections({ name: "auditevents" }).toArray()).length, 0);
  } finally { if (service.exitCode !== null || service.signalCode) service = await startService(port); }
});

test("a lost HTTP acknowledgment retries the same envelope and retains the original history ID", async () => {
  const event = await enqueue();
  let original;
  await withServer(async (req, res) => {
    const response = await forward(req); original = (await response.json()).data;
    res.destroy(); // Persisted remotely, but no ACK reaches the sender.
  }, async (url) => assert.equal((await (await worker(url)).deliverNext()).status, "RETRY"));
  assert.equal(await history.countDocuments(), 1); await forceReady(event);
  assert.equal((await (await worker()).deliverNext()).status, "DELIVERED");
  assert.equal((await events().findOne()).auditId, original.auditId);
  assert.equal(await history.countDocuments(), 1);
});

test("invalid or mismatched acknowledgments never settle an outbox delivery", async () => {
  const event = await enqueue(); let body, status = 201;
  await withServer((_req, res) => json(res, status, body), async (url) => {
    const instance = await worker(url, { maxAttempts: 20 });
    for (body of [null, {}, { data: null }, acknowledgment(event, { eventId: randomUUID() }),
      acknowledgment(event, { producer: "identity" }), acknowledgment(event, { auditId: "invalid" }),
      acknowledgment(event, { duplicate: true }), acknowledgment(event, { duplicate: 0 }),
      acknowledgment(event, { extra: "never-log-remote-payload" }), { ...acknowledgment(event), extra: true }]) {
      const result = await instance.deliverNext();
      assert.equal(result.code, "INVALID_ACKNOWLEDGMENT"); await forceReady(event);
    }
    status = 200; body = acknowledgment(event);
    assert.equal((await instance.deliverNext()).code, "INVALID_ACKNOWLEDGMENT");
    for (status of [202, 204, 400, 500]) {
      await forceReady(event);
      assert.equal((await instance.deliverNext()).code, "DELIVERY_FAILED");
    }
  });
  assert.equal((await events().findOne()).auditId, undefined);
  assert.equal(await history.countDocuments(), 0);
  assert.doesNotMatch(JSON.stringify(await events().findOne()), /never-log/);
});

test("non-JSON, malformed, declared-large, chunked-large, and compressed-large ACKs are bounded", async () => {
  const event = await enqueue(); let reply;
  await withServer((_req, res) => reply(res), async (url) => {
    const instance = await worker(url, { maxAttempts: 10 });
    for (reply of [
      (res) => res.writeHead(201, { "Content-Type": "text/html" }).end("never-log-remote-payload"),
      (res) => res.writeHead(201, { "Content-Type": "application/json" }).end("{"),
      (res) => res.writeHead(201, { "Content-Type": "application/json", "Content-Length": "8192" }).end("x".repeat(8192)),
      (res) => { res.writeHead(201, { "Content-Type": "application/json" }); res.write("x".repeat(4097)); res.end(); },
      (res) => res.writeHead(201, { "Content-Type": "application/json", "Content-Encoding": "gzip" }).end(gzipSync("x".repeat(8192))),
    ]) {
      assert.equal((await instance.deliverNext()).code, "INVALID_ACKNOWLEDGMENT"); await forceReady(event);
    }
  });
  assert.equal((await events().findOne()).status, "PENDING");
});

test("HTTP deadlines cover response headers and streaming bodies, and worker aborts propagate", async () => {
  const event = await enqueue();
  for (const partial of [false, true]) await withServer((_req, res) => {
    if (partial) { res.writeHead(201, { "Content-Type": "application/json" }); res.write('{"data":'); }
  }, async (url) => {
    const instance = await worker(url, {}, 100);
    assert.equal((await instance.deliverNext()).code, "DELIVERY_TIMEOUT"); await forceReady(event);
  });
  await withServer(() => {}, async (url) => {
    const instance = await worker(url, { leaseMs: 1000, deliveryTimeoutMs: 100 });
    assert.equal((await instance.deliverNext()).code, "DELIVERY_TIMEOUT");
  });
  await forceReady(event);
  assert.equal((await (await worker()).deliverNext()).status, "DELIVERED");
  assert.equal(await history.countDocuments(), 1);
});

test("redirects never forward service credentials or event bodies to another target", async () => {
  const event = await enqueue(); let targetCalls = 0;
  await withServer((_req, res) => { targetCalls++; res.end(); }, async (target) => {
    await withServer((_req, res) => res.writeHead(307, { Location: target }).end(), async (url) => {
      assert.equal((await (await worker(url)).deliverNext()).status, "RETRY");
    });
  });
  assert.equal(targetCalls, 0); assert.deepEqual((await events().findOne()).event, event);
});

test("auth, rate-limit, and unavailable responses retain intent and honor bounded Retry-After", async () => {
  const event = await enqueue(); let status, hint;
  await withServer((_req, res) => json(res, status, { error: { message: "never-log-remote-credentials" } }, { "Retry-After": hint }), async (url) => {
    const instance = await worker(url, { maxAttempts: 10, retryBaseMs: 100, retryMaxMs: 200 });
    for (const [responseStatus, retryAfter, code, delay] of [[401, "1", "DELIVERY_UNAUTHORIZED", 100],
      [403, "1", "DELIVERY_UNAUTHORIZED", 200], [429, "60", "DELIVERY_RATE_LIMITED", 60000],
      [503, "120", "DELIVERY_FAILED", 120000], [503, "999999999", "DELIVERY_FAILED", 86400000],
      [503, "invalid", "DELIVERY_FAILED", 200]]) {
      status = responseStatus; hint = retryAfter;
      assert.equal((await instance.deliverNext()).code, code);
      const row = await events().findOne(); assert.equal(row.availableAt - row.lastFailureAt, delay);
      assert.equal(row.status, "PENDING"); assert.equal(row.auditId, undefined); await forceReady(event);
    }
    status = 503; hint = new Date(Date.now() + 60000).toUTCString();
    assert.equal((await instance.deliverNext()).code, "DELIVERY_FAILED");
    const row = await events().findOne();
    assert.ok(row.availableAt - row.lastFailureAt >= 58000 && row.availableAt - row.lastFailureAt <= 60000);
  });
  assert.doesNotMatch(JSON.stringify(await events().findOne()), /never-log/);
});

test("only a documented receiver conflict fails immediately; retained history is never overwritten", async () => {
  const event = await enqueue();
  const conflicting = { ...event, requestId: "original" };
  const response = await fetch(service.endpoint + "/internal/v1/events", { method: "POST", headers: {
    Authorization: `Bearer ${jwt.sign({}, keys.employees, { issuer: ISSUER, audience: AUDIENCE, subject: "employees", expiresIn: 60 })}`,
    "Content-Type": "application/json" }, body: JSON.stringify(conflicting) });
  assert.equal(response.status, 201); const original = (await response.json()).data;
  const instance = await worker(); assert.equal((await instance.deliverNext()).code, "DELIVERY_CONFLICT");
  assert.equal((await events().findOne()).status, "FAILED");
  assert.equal((await history.findOne())._id.toHexString(), original.auditId);
  assert.equal((await history.findOne()).requestId, "original");
  await instance.replay(event.eventId);
  await withServer((_req, res) => json(res, 409, { error: { code: "PROXY_CONFLICT", message: "never-log" } }), async (url) => {
    assert.equal((await (await worker(url)).deliverNext()).code, "INVALID_ACKNOWLEDGMENT");
  });
  assert.equal((await events().findOne()).status, "PENDING");
});

test("independent remote worker processes compete for one claim and persist one history event", async () => {
  const event = await enqueue();
  await Promise.all([cli(), cli()]);
  const row = await events().findOne(); assert.equal(row.attempts, 1); assert.equal(row.status, "DELIVERED");
  assert.equal((await history.findOne({ "_delivery.eventId": event.eventId }))._id.toHexString(), row.auditId);
  assert.equal(await history.countDocuments(), 1);
});

test("a killed HTTP worker recovers an expired lease after remote persistence without duplicates", async () => {
  const event = await enqueue(); let persisted, original;
  const gate = new Promise((resolve) => { persisted = resolve; });
  await withServer(async (req) => {
    const response = await forward(req); original = (await response.json()).data; persisted();
    // Deliberately leave the response open between remote persistence and ACK.
  }, async (url) => {
    const child = await start("audit-worker", workerEnv(url), (entry) => entry.status === "READY");
    let timer;
    try {
      await Promise.race([gate, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Remote persistence timeout")), 10000); })]);
      await stop(child, "SIGKILL");
      assert.equal((await events().findOne()).status, "IN_FLIGHT");
    } finally { clearTimeout(timer); await stop(child); }
  });
  await forceReady(event); await cli();
  const row = await events().findOne(); assert.equal(row.attempts, 2); assert.equal(row.auditId, original.auditId);
  assert.equal(row.status, "DELIVERED"); assert.equal(await history.countDocuments(), 1);
});

test("SIGTERM drains an active HTTP attempt before stopping heartbeats and closing the producer client", async () => {
  const event = await enqueue(); let persisted, release;
  const gate = new Promise((resolve) => { persisted = resolve; });
  const responseGate = new Promise((resolve) => { release = resolve; });
  await withServer(async (req, res) => {
    const response = await forward(req), body = await response.json();
    persisted(); await responseGate; json(res, response.status, body);
  }, async (url) => {
    const child = await start("audit-worker", workerEnv(url), (entry) => entry.status === "READY");
    let timer;
    try {
      await Promise.race([gate, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Active delivery timeout")), 10000); })]);
      const exited = once(child, "exit");
      child.kill("SIGTERM"); release();
      const [code, signal] = await exited;
      assert.equal(code, 0); assert.equal(signal, null);
      assert.equal((await events().findOne({ _id: event.eventId })).status, "DELIVERED");
      for (const name of ["employee_audit_workers", "identity_audit_workers"])
        assert.equal(await db.collection(name).countDocuments({ status: "RUNNING" }), 0);
    } finally { clearTimeout(timer); release(); await stop(child); }
  });
});
