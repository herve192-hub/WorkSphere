const { test, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const { connect } = require("node:net");
const path = require("node:path");
const mongoose = require("mongoose");
const { MongoClient, ObjectId } = mongoose.mongo;
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const parser = require("@apidevtools/swagger-parser");
const Ajv = require("ajv");
const formats = require("ajv-formats");
const { createAuditService, RATE_LIMIT_COLLECTION } = require("../src/audit-service/app");
const { loadAuditServiceConfig } = require("../src/audit-service/config");
const { ISSUER, AUDIENCE } = require("../src/audit-service/authentication");
const { prepareAuditEvent } = require("../src/contracts/auditEvent");
const { loadContract, assertResponse } = require("./helpers/contract");
const backend = path.resolve(__dirname, "..");
const database = "audit_http_private";
const actorId = "abcdefabcdefabcdefabcdef", resourceId = "123456789012345678901234";
const keys = Object.fromEntries(["employees", "identity", "api"].map((name) => [name, randomBytes(32).toString("hex")]));
const rootPassword = randomBytes(32).toString("hex"), servicePassword = randomBytes(32).toString("hex");
const children = new Set();
let mongo, root, connection, db, endpoints, contract;
const ajv = new Ajv({ strict: false, allErrors: true });
formats(ajv);
const validators = new Map();

function token(subject = "employees", claims = {}, options = {}) {
  return jwt.sign({ ...(subject === "api" ? { actorId, role: "ADMIN" } : {}), ...claims }, keys[subject],
    { algorithm: "HS256", issuer: ISSUER, audience: AUDIENCE, subject, expiresIn: 60, ...options });
}
function envelope(producer = "employees", sequence = 1) {
  return { ...prepareAuditEvent(producer === "employees" ? {
    action: "EMPLOYEE_UPDATED", actor: { id: actorId, firstName: "Jamie", lastName: "Morgan", email: "jamie@example.com", role: "ADMIN" },
    resource: { type: "EMPLOYEE", id: resourceId, label: "EMP-000001" },
    changes: [{ field: "department", before: "Engineering", after: "Platform" }], requestId: "private-audit-fixture",
  } : { action: "AUTH_LOGIN_FAILED", actor: null, resource: { type: "ACCOUNT", id: null, label: "" }, requestId: "private-audit-fixture" },
  { producer, occurredAt: "2026-01-01T12:00:00.000Z" }), sequence };
}
function uri(user, password, name = database) {
  const result = new URL(mongo.getUri(name));
  result.username = user; result.password = password; result.searchParams.set("authSource", "admin");
  return result.href;
}
async function startProcess(overrides = {}) {
  const child = spawn(process.execPath, ["scripts/audit-service.js"], { cwd: backend, env: {
    ...process.env, JWT_ACCESS_SECRET: "", AUDIT_MONGO_URI: uri("audit-http", servicePassword),
    AUDIT_SERVICE_KEYS: JSON.stringify(keys), AUDIT_HOST: "127.0.0.1", AUDIT_PORT: "0", ...overrides,
  }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  child.output = "";
  child.stdout.on("data", (chunk) => { child.output = (child.output + chunk).slice(-20000); });
  child.stderr.on("data", (chunk) => { child.output = (child.output + chunk).slice(-20000); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Audit fixture startup timed out")); }, 20000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Audit fixture failed before readiness")); });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
      for (const line of output.split("\n")) {
        try {
          const entry = JSON.parse(line);
          if (entry.message === "audit_service_ready") {
            child.endpoint = `http://127.0.0.1:${entry.port}`;
            clearTimeout(timer); resolve(); return;
          }
        } catch {} // Startup lines can be split across pipe reads.
      }
    });
  });
  return child;
}
async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode) { children.delete(child); return; }
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill("SIGKILL"), 16000);
  child.kill("SIGTERM");
  try { return await exited; } finally { clearTimeout(timer); children.delete(child); }
}
function validate(response, route, method) {
  const schema = contract.paths[route][method].responses[response.status]?.content?.["application/json"]?.schema;
  assert.ok(schema, `Undocumented private response: ${method} ${route} ${response.status}`);
  const key = `${route}:${method}:${response.status}`;
  if (!validators.has(key)) validators.set(key, ajv.compile(schema));
  const valid = validators.get(key);
  assert.equal(valid(response.body), true, JSON.stringify(valid.errors));
}
async function api(worker, method, route, bearer, body) {
  const response = await fetch(endpoints[worker] + route, { method,
    headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const result = { status: response.status, headers: response.headers, body: await response.json() };
  validate(result, route.split("?")[0].replace(/\/[a-f0-9]{24}$/i, "/{id}"), method.toLowerCase());
  return result;
}
before(async () => {
  await loadContract();
  contract = await parser.dereference(structuredClone(require("../src/audit-service/openapi")), { resolve: { external: false } });
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, auth: {
    enable: true, customRootName: "fixture-root", customRootPwd: rootPassword, keyfileContent: randomBytes(32).toString("hex"),
  } } });
  root = new MongoClient(uri("fixture-root", rootPassword));
  await root.connect();
  await root.db("admin").command({ createUser: "audit-http", pwd: servicePassword, roles: [{ role: "readWrite", db: database }] });
  connection = new MongoClient(uri("audit-http", servicePassword));
  await connection.connect(); db = connection.db(database);
  const workers = await Promise.all([startProcess(), startProcess()]);
  endpoints = workers.map((child) => child.endpoint);
});
beforeEach(async () => {
  await db.collection("auditevents").deleteMany({});
  await db.collection(RATE_LIMIT_COLLECTION).deleteMany({});
  assert.equal(mongoose.connection.readyState, 0);
});
after(async () => {
  await Promise.all([...children].map(stopProcess));
  await Promise.all([connection?.close(), root?.close()]);
  if (mongo) await mongo.stop();
});

test("private Audit configuration rejects missing, reused, placeholder, and browser credentials", () => {
  const valid = { AUDIT_MONGO_URI: uri("audit-http", servicePassword), AUDIT_SERVICE_KEYS: JSON.stringify(keys) };
  assert.equal(loadAuditServiceConfig(valid).host, "127.0.0.1");
  for (const overrides of [
    { AUDIT_MONGO_URI: undefined, MONGO_URI: valid.AUDIT_MONGO_URI }, { AUDIT_SERVICE_KEYS: "invalid" },
    { AUDIT_SERVICE_KEYS: JSON.stringify({ ...keys, api: keys.employees }) }, { AUDIT_SERVICE_KEYS: JSON.stringify({ ...keys, extra: keys.api }) },
    { AUDIT_SERVICE_KEYS: JSON.stringify({ ...keys, api: "replace-with-a-random-secret-for-this-service" }) },
    { JWT_ACCESS_SECRET: keys.api }, { AUDIT_PORT: "70000" }, { AUDIT_PORT: "" }, { AUDIT_HOST: "public.example.com" },
  ]) assert.throws(() => loadAuditServiceConfig({ ...valid, ...overrides }));
});

test("unsigned, forged, expired, long-lived, future-issued, and browser tokens cannot access Audit", async () => {
  const now = Math.floor(Date.now() / 1000);
  const missingExpiry = jwt.sign({ sub: "employees", iss: ISSUER, aud: AUDIENCE }, keys.employees, { algorithm: "HS256" });
  const wrongSubjectKey = jwt.sign({ sub: "identity" }, keys.employees, { issuer: ISSUER, audience: AUDIENCE, expiresIn: 60 });
  for (const bearer of [undefined, "invalid", token("employees", {}, { algorithm: "none" }),
    token("employees", {}, { algorithm: "HS384" }), token("employees", {}, { audience: "worksphere-web" }),
    token("employees", {}, { issuer: "worksphere" }), token("employees", {}, { expiresIn: -1 }),
    token("employees", {}, { expiresIn: 3600 }), token("employees", { iat: now + 30 }),
    token("employees", {}, { noTimestamp: true }), missingExpiry, wrongSubjectKey]) {
    const result = await api(0, "POST", "/internal/v1/events", bearer, envelope());
    assert.equal(result.status, 401);
    assert.equal(result.headers.get("www-authenticate"), 'Bearer realm="worksphere-audit"');
  }
  assert.equal(await db.collection("auditevents").countDocuments(), 0);
});

test("Audit CLI help works without credentials and startup failures do not print them", () => {
  const clean = { ...process.env, AUDIT_MONGO_URI: "", AUDIT_SERVICE_KEYS: "", JWT_ACCESS_SECRET: "" };
  const help = spawnSync(process.execPath, ["scripts/audit-service.js", "--help"], { cwd: backend, env: clean, encoding: "utf8", timeout: 5000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node scripts\/audit-service.js/);
  const invalid = spawnSync(process.execPath, ["scripts/audit-service.js"], { cwd: backend,
    env: { ...clean, AUDIT_MONGO_URI: "mongodb://never-log-user:never-log-password@127.0.0.1:1/private", AUDIT_SERVICE_KEYS: "not-json" },
    encoding: "utf8", timeout: 5000 });
  assert.equal(invalid.status, 1);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /never-log|not-json/);
});

test("producer permissions and signed API principal roles prevent impersonation and history disclosure", async () => {
  assert.equal((await api(0, "POST", "/internal/v1/events", token("employees"), envelope("identity"))).status, 403);
  assert.equal((await api(0, "POST", "/internal/v1/events", token("api"), envelope())).status, 403);
  assert.equal((await api(0, "GET", "/internal/v1/events", token("employees", { role: "ADMIN", actorId }))).status, 403);
  for (const claims of [{ role: "EMPLOYEE" }, { role: undefined }, { actorId: undefined }, { actorId: "invalid" }])
    assert.equal((await api(0, "GET", "/internal/v1/events", token("api", claims))).status, 403);
  for (const role of ["ADMIN", "HR_MANAGER"])
    assert.equal((await api(1, "GET", "/internal/v1/events", token("api", { role }))).status, 200);
  assert.equal(await db.collection("auditevents").countDocuments(), 0);
});

test("independent HTTP receivers persist once, retain ACK identity, and reject conflicting history", async () => {
  const event = envelope();
  const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => api(index % 2, "POST", "/internal/v1/events", token(), event)));
  assert.equal(responses.filter((response) => response.status === 201).length, 1);
  assert.equal(responses.filter((response) => response.status === 200).length, 11);
  assert.equal(new Set(responses.map((response) => response.body.data.auditId)).size, 1);
  assert.ok(responses.every((response) => response.body.data.eventId === event.eventId && response.body.data.producer === "employees"));
  const conflict = await api(0, "POST", "/internal/v1/events", token(), { ...event, requestId: "changed" });
  assert.equal(conflict.status, 409);
  const position = await api(1, "POST", "/internal/v1/events", token(), { ...envelope(), sequence: event.sequence });
  assert.equal(position.status, 409);
  assert.equal(await db.collection("auditevents").countDocuments(), 1);
});

test("private queries preserve public schemas, legacy history, filters, and hidden delivery metadata", async () => {
  const created = await api(0, "POST", "/internal/v1/events", token(), envelope());
  const id = created.body.data.auditId;
  await db.collection("auditevents").insertOne({ action: "AUTH_LOGIN_FAILED", actor: null,
    resource: { type: "ACCOUNT", id: null, label: "" }, changes: [], requestId: "legacy-http", occurredAt: new Date("2025-01-01T00:00:00.000Z") });
  const result = await api(1, "GET", `/internal/v1/events?resourceId=${resourceId}&actorId=${actorId}&from=2026-01-01&to=2026-01-01&search=EMP-`, token("api"));
  assert.equal(result.body.pagination.totalItems, 1);
  assertResponse(result, "/api/v1/audit", "get");
  const detail = await api(0, "GET", `/internal/v1/events/${id}`, token("api"));
  assertResponse(detail, "/api/v1/audit/{id}", "get");
  assert.equal(detail.headers.get("cache-control"), "no-store");
  assert.equal(detail.headers.get("access-control-allow-origin"), null);
  assert.equal(detail.headers.get("set-cookie"), null);
  assert.doesNotMatch(JSON.stringify(detail.body), /_delivery|fingerprint/);
  assert.equal((await api(0, "GET", "/internal/v1/events", token("api"))).body.pagination.totalItems, 2);
  assert.equal((await api(0, "GET", "/internal/v1/events?search=.*", token("api"))).body.pagination.totalItems, 0);
  assert.equal((await api(0, "GET", "/internal/v1/events?actorId=invalid", token("api"))).status, 400);
  assert.equal((await api(0, "GET", "/internal/v1/events?search=a&search=b", token("api"))).status, 400);
  assert.equal((await api(0, "GET", `/internal/v1/events/${new ObjectId()}`, token("api"))).status, 404);
  await assert.rejects(connection.db("business_private").collection("accounts").findOne(), { code: 13 });
  assert.equal(mongoose.connection.readyState, 0);
});

test("invalid, oversized, malformed, and compressed bodies cannot write history", async () => {
  const service = createAuditService({ db, keys }); await service.initialize();
  const call = () => request(service.app).post("/internal/v1/events").set("Authorization", `Bearer ${token()}`);
  for (const body of [{ ...envelope(), schemaVersion: 2 }, { ...envelope(), password: "never-retain-password" }, { ...envelope(), sequence: 0 }])
    assert.equal((await call().send(body)).status, 400);
  assert.equal((await call().set("Content-Type", "application/json").send('{"secret":"never-retain-raw-json",')).status, 400);
  assert.equal((await call().send({ ...envelope(), extra: "x".repeat(65536) })).status, 413);
  assert.equal((await call().set("Content-Encoding", "gzip").set("Content-Type", "application/json").send("compressed-placeholder")).status, 415);
  const denied = await request(service.app).post("/internal/v1/events").set("Cookie", "ws_access=invalid").send(envelope());
  assert.equal(denied.status, 401);
  assert.equal(await db.collection("auditevents").countDocuments(), 0);
});

test("producer and query budgets are shared across HTTP processes and remain independent", async () => {
  const event = envelope();
  await api(0, "POST", "/internal/v1/events", token(), event);
  const limits = db.collection(RATE_LIMIT_COLLECTION);
  await limits.updateOne({ _id: /^audit:http:ingest:/ }, { $set: { totalHits: 599 } });
  const results = await Promise.all([0, 1].map((worker) => api(worker, "POST", "/internal/v1/events", token(), event)));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 429]);
  assert.ok(Number(results.find((result) => result.status === 429).headers.get("retry-after")) > 0);
  assert.equal((await api(1, "POST", "/internal/v1/events", token("identity"), envelope("identity"))).status, 201);
  assert.equal((await api(0, "GET", "/internal/v1/events", token("api"))).status, 200);
  await limits.updateOne({ _id: /^audit:http:read:/ }, { $set: { totalHits: 119 } });
  const reads = await Promise.all([0, 1].map((worker) => api(worker, "GET", "/internal/v1/events", token("api"))));
  assert.deepEqual(reads.map((result) => result.status).sort(), [200, 429]);
  const stored = await limits.find().toArray();
  assert.ok(stored.every((record) => /:[a-f0-9]{64}$/.test(record._id)));
  assert.equal(await root.db("business_private").collection("authratelimits").countDocuments(), 0);
});

test("shared ingress limits and failed stores stop authentication, parsing, and history access", async () => {
  const service = createAuditService({ db, keys }); await service.initialize();
  const limits = db.collection(RATE_LIMIT_COLLECTION);
  await request(service.app).get("/internal/v1/events");
  await limits.updateOne({ _id: /^audit:http:ip:/ }, { $set: { totalHits: 1200 } });
  const verify = mock.method(jwt, "verify");
  try {
    const limited = await request(service.app).post("/internal/v1/events").set("Authorization", `Bearer ${token()}`)
      .set("Content-Type", "application/json").send("malformed-json");
    assert.equal(limited.status, 429);
    assert.equal(verify.mock.callCount(), 0);
    const prototype = limits.constructor.prototype;
    const broken = mock.method(prototype, "findOneAndUpdate", async () => { throw new Error("never-log-storage-credentials"); });
    try {
      const failed = await request(service.app).get("/internal/v1/events").set("Authorization", `Bearer ${token("api")}`);
      assert.equal(failed.status, 503);
      assert.equal(verify.mock.callCount(), 0);
      assert.doesNotMatch(JSON.stringify(failed.body), /never-log/);
    } finally { broken.mock.restore(); }
  } finally { verify.mock.restore(); }
  assert.equal(await db.collection("auditevents").countDocuments(), 0);
});

test("readiness tracks initialization, database reachability, and draining; liveness stays available", async () => {
  const local = new MongoClient(uri("audit-http", servicePassword)); await local.connect();
  const service = createAuditService({ db: local.db(database), keys });
  try {
    assert.equal((await request(service.app).get("/health/live")).status, 200);
    assert.equal((await request(service.app).get("/health/ready")).status, 503);
    assert.equal((await request(service.app).get("/internal/v1/events")).status, 503);
    await service.initialize();
    assert.equal((await request(service.app).get("/health/ready")).status, 200);
    await local.close();
    assert.equal((await request(service.app).get("/health/live")).status, 200);
    assert.equal((await request(service.app).get("/health/ready")).status, 503);
    service.beginShutdown();
    assert.equal((await request(service.app).post("/internal/v1/events").send(envelope())).status, 503);
  } finally { await local.close(); }
});

test("storage errors and request logs never expose tokens, payloads, query values, or database errors", async () => {
  const service = createAuditService({ db, keys }); await service.initialize();
  const output = [];
  const info = mock.method(console, "log", (line) => output.push(line));
  const error = mock.method(console, "error", (line) => output.push(line));
  const broken = mock.method(db.collection("auditevents").constructor.prototype, "insertOne", async () => { throw new Error("never-log-storage-credentials"); });
  const bearer = token();
  try {
    const result = await request(service.app).post("/internal/v1/events?search=never-log-query@example.com")
      .set("Authorization", `Bearer ${bearer}`).send(envelope());
    assert.equal(result.status, 503);
    assert.equal(result.headers["retry-after"], "1");
    assert.doesNotMatch(JSON.stringify(result.body), /never-log|jamie@example|EMP-/);
    assert.doesNotMatch(output.join("\n"), /never-log|jamie@example|EMP-/);
    assert.ok(!output.join("\n").includes(bearer));
  } finally { broken.mock.restore(); info.mock.restore(); error.mock.restore(); }
});

test("incomplete HTTP headers expire before the socket inactivity deadline", async () => {
  const { hostname, port } = new URL(endpoints[0]);
  const socket = connect({ host: hostname, port: Number(port) });
  let output = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => { output += chunk; });
  // A real partial request exercises Node's timeout checker, not just configured
  // properties; its default 30-second scan would miss our five-second header limit.
  const timer = setTimeout(() => socket.destroy(new Error("Incomplete headers were not expired.")), 9000);
  try {
    const closed = once(socket, "close");
    socket.once("connect", () => socket.write("GET /health/live HTTP/1.1\r\nHost: localhost\r\nX-Incomplete: "));
    await closed;
    assert.match(output, /^HTTP\/1\.1 408 /);
    assert.equal(await db.collection("auditevents").countDocuments(), 0);
  } finally { clearTimeout(timer); socket.destroy(); }
});

test("real Audit process restarts preserve history/ACK identity and gracefully close its listener", async () => {
  const child = await startProcess();
  const event = envelope();
  const delivered = await fetch(child.endpoint + "/internal/v1/events", { method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" }, body: JSON.stringify(event) });
  assert.equal(delivered.status, 201);
  const original = (await delivered.json()).data;
  const [code, signal] = await stopProcess(child);
  assert.equal(code, 0); assert.equal(signal, null);
  assert.match(child.output, /audit_service_stopped/);
  await assert.rejects(fetch(child.endpoint + "/health/live", { signal: AbortSignal.timeout(1000) }));
  const restarted = await startProcess();
  try {
    const replay = await fetch(restarted.endpoint + "/internal/v1/events", { method: "POST",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" }, body: JSON.stringify(event) });
    assert.equal(replay.status, 200);
    assert.deepEqual((await replay.json()).data, { ...original, duplicate: true });
  } finally { await stopProcess(restarted); }
});
