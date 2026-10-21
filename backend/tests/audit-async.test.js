process.env.JWT_ACCESS_SECRET = "test-only-secret-with-more-than-32-characters";
process.env.CLIENT_ORIGIN = "http://localhost:3000";
process.env.AUDIT_DELIVERY_MODE = "async";
const { test, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const { fork, spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { once } = require("node:events");
const { setTimeout: delay } = require("node:timers/promises");
const path = require("node:path");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const app = require("../src/app");
const Account = require("../src/modules/identity/Account");
const Session = require("../src/modules/identity/Session");
const Employee = require("../src/modules/employees/Employee");
const AuditEvent = require("../src/modules/audit/AuditEvent");
const { createAuditConsumer } = require("../src/modules/audit");
const { createAuditWorker, createAuditHeartbeat, getAuditDeliveryStatus } = require("../src/outbox");
const { auditDeliveryMode } = require("../src/outbox/policy");
const { loadContract, assertResponse } = require("./helpers/contract");
const origin = process.env.CLIENT_ORIGIN;
const profile = { firstName: "Jamie", lastName: "Morgan", email: "async@example.com", department: "Engineering" };
const password = "a long secure passphrase";
const cookies = {}, accounts = {}, children = new Set();
const backend = path.resolve(__dirname, "..");
let mongo;
const responseCookies = (res) => res.headers["set-cookie"].map((value) => value.split(";")[0]);
async function api(method, resource, role = "ADMIN", body) {
  const call = request(app)[method]("/api/v1" + resource).set("Origin", origin).set("X-Request-Id", "async-test");
  if (role) call.set("Cookie", cookies[role]);
  const response = await (body === undefined ? call : call.send(body));
  assertResponse(response, "/api/v1" + resource.split("?")[0].replace(/\/[a-f\d]{24}$/i, "/{id}"), method);
  return response;
}
const collection = (producer) => mongoose.connection.db.collection(`${producer}_audit_outbox`);
async function withBrokenCollection(name, operation) {
  const prototype = mongoose.connection.db.collection(name).constructor.prototype;
  const insertOne = prototype.insertOne;
  const broken = mock.method(prototype, "insertOne", async function (...args) {
    if (this.collectionName === name) throw new Error("never-store-receiver-secret");
    return insertOne.apply(this, args);
  });
  try { await operation(); } finally { broken.mock.restore(); }
}
async function newWorker(producer) {
  const receiver = createAuditConsumer(mongoose.connection.db);
  await receiver.initialize();
  const instance = createAuditWorker(mongoose.connection.db, producer, (event, context) => receiver.consume(event, context));
  await instance.initialize();
  return instance;
}
async function drain(instance, expected) {
  let delivered = 0;
  for (let iteration = 0; iteration < 30; iteration++) {
    const result = await instance.deliverNext();
    if (result.status === "IDLE") break;
    assert.equal(result.status, "DELIVERED");
    delivered++;
  }
  assert.equal(delivered, expected);
}
async function waitFor(operation) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await operation()) return; await delay(25); }
  throw new Error("Fixture recovery timeout");
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode) { children.delete(child); return; }
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  if (child.channel && child.connected) child.send("close"); else child.kill("SIGTERM");
  try { await exited; } finally { clearTimeout(timer); children.delete(child); }
}
async function startWorker() {
  const child = spawn(process.execPath, ["scripts/audit-worker.js"], {
    cwd: backend, env: { ...process.env, MONGO_URI: mongo.getUri(), JWT_ACCESS_SECRET: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "", timer;
  try {
    await Promise.race([
      new Promise((resolve) => child.stdout.on("data", (chunk) => { output += chunk; if (output.includes('"status":"READY"')) resolve(); })),
      once(child, "exit").then(() => { throw new Error("Fixture worker exited before startup"); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture startup timeout")), 10000); }),
    ]);
  } finally { clearTimeout(timer); }
  return child;
}
before(async () => {
  await loadContract();
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all(["identity", "employees", "audit"].map((domain) => require(`../src/modules/${domain}`).initialize()));
  const passwordHash = await bcrypt.hash(password, 4);
  for (const role of ["ADMIN", "HR_MANAGER", "EMPLOYEE"]) {
    accounts[role] = await Account.create({ ...profile, email: `${role.toLowerCase()}@example.com`, role, passwordHash });
    const response = await api("post", "/auth/login", null, { email: accounts[role].email, password });
    assert.equal(response.status, 200);
    cookies[role] = responseCookies(response);
  }
});
beforeEach(async () => {
  await AuditEvent.deleteMany({});
  await Employee.deleteMany({});
  for (const name of ["counters", "authratelimits", "employee_audit_outbox", "employee_audit_sequences", "identity_audit_outbox", "identity_audit_sequences", "employee_audit_workers", "identity_audit_workers"])
    await mongoose.connection.db.collection(name).deleteMany({});
});
after(async () => {
  await Promise.all([...children].map(stop));
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

test("async employee writes survive receiver failure and recover ordered, immutable history", async () => {
  const instance = await newWorker("employees");
  let employee;
  await withBrokenCollection("auditevents", async () => {
    const created = await api("post", "/employees", "ADMIN", profile);
    assert.equal(created.status, 201);
    employee = created.body.data;
    assert.equal((await api("patch", `/employees/${employee._id}`, "ADMIN", { department: "Platform" })).status, 200);
    assert.equal((await api("delete", `/employees/${employee._id}`)).status, 204);
    assert.equal(await AuditEvent.countDocuments(), 0);
    assert.equal(await collection("employee").countDocuments(), 3);
    assert.equal((await instance.deliverNext()).status, "RETRY");
    assert.equal((await api("get", `/audit?resourceId=${employee._id}`)).body.data.length, 0);
    assert.equal((await request(app).get("/health/ready")).status, 200);
    const health = await api("get", "/operations/audit");
    assert.equal(health.status, 503);
    assert.equal(health.body.producers.employees.pending, 3);
    assert.equal(health.body.mode, "async");
  });
  await collection("employee").updateMany({}, { $set: { availableAt: new Date(0) } });
  await drain(instance, 3);
  const history = await api("get", `/audit?resourceId=${employee._id}`);
  assert.deepEqual(history.body.data.map((event) => event.action), ["EMPLOYEE_DELETED", "EMPLOYEE_UPDATED", "EMPLOYEE_CREATED"]);
  assert.deepEqual(history.body.data[1].changes.find((change) => change.field === "department"), { field: "department", before: "Engineering", after: "Platform" });
  assert.ok(history.body.data.every((event) => event.resource.label === employee.employeeNumber && !event._delivery));
  const receiver = createAuditConsumer(mongoose.connection.db);
  await receiver.initialize();
  for (const row of await collection("employee").find().toArray())
    assert.equal((await receiver.consume(row.event, { producer: "employees" })).duplicate, true);
  assert.equal(await AuditEvent.countDocuments(), 3);
});

test("account/session lifecycle and anonymous failures commit while the receiver is unavailable", async () => {
  const credentials = { ...profile, email: "async-identity@example.com", password };
  await withBrokenCollection("auditevents", async () => {
    assert.equal((await api("post", "/auth/register", null, credentials)).status, 201);
    const failed = await api("post", "/auth/login", null, { email: "never-store-attempt@example.com", password: "never-store-password" });
    assert.equal(failed.status, 401);
    assert.equal(failed.headers["set-cookie"], undefined);
    const login = await api("post", "/auth/login", null, credentials);
    assert.equal(login.status, 200);
    cookies.NEW = responseCookies(login);
    const refresh = await api("post", "/auth/refresh", "NEW");
    assert.equal(refresh.status, 200);
    assert.equal((await api("get", "/auth/me", "NEW")).status, 401);
    cookies.NEW = responseCookies(refresh);
    assert.equal((await api("post", "/auth/logout", "NEW")).status, 204);
    assert.equal((await api("get", "/auth/me", "NEW")).status, 401);
    assert.equal(await AuditEvent.countDocuments(), 0);
  });
  const intents = await collection("identity").find().toArray();
  assert.equal(intents.length, 5);
  assert.doesNotMatch(JSON.stringify(intents), /never-store|passwordHash|tokenHash|ws_access|ws_refresh/);
  const anonymous = intents.find((row) => row.event.action === "AUTH_LOGIN_FAILED");
  assert.equal(anonymous.event.actor, null);
  assert.deepEqual(anonymous.event.resource, { type: "ACCOUNT", id: null, label: "" });
  await drain(await newWorker("identity"), 5);
  assert.equal(await AuditEvent.countDocuments(), 5);
});

test("outbox failures still abort async business writes and session rotation before cookies", async () => {
  await withBrokenCollection("employee_audit_outbox", async () => {
    assert.equal((await api("post", "/employees", "ADMIN", profile)).status, 500);
    assert.equal(await Employee.countDocuments(), 0);
  });
  const before = await Session.find().sort({ _id: 1 }).lean();
  await withBrokenCollection("identity_audit_outbox", async () => {
    for (const [resource, role, body] of [
      ["/auth/register", null, { ...profile, password }],
      ["/auth/login", null, { email: accounts.ADMIN.email, password }],
      ["/auth/refresh", "ADMIN"], ["/auth/logout", "ADMIN"],
    ]) {
      const response = await api("post", resource, role, body);
      assert.equal(response.status, 500);
      assert.equal(response.headers["set-cookie"], undefined);
    }
  });
  assert.equal(await Account.exists({ email: profile.email }), null);
  assert.deepEqual(await Session.find().sort({ _id: 1 }).lean(), before);
  assert.equal((await api("get", "/auth/me")).status, 200);
  assert.equal(await collection("employee").countDocuments(), 0);
  assert.equal(await collection("identity").countDocuments(), 0);
  assert.equal(await mongoose.connection.db.collection("employee_audit_sequences").countDocuments(), 0);
  assert.equal(await mongoose.connection.db.collection("identity_audit_sequences").countDocuments(), 0);
});

test("delivery health is admin-only and exposes aggregate state without employee or worker identities", async () => {
  assert.equal((await api("get", "/operations/audit", null)).status, 401);
  for (const role of ["HR_MANAGER", "EMPLOYEE"]) assert.equal((await api("get", "/operations/audit", role)).status, 403);
  await api("post", "/employees", "ADMIN", profile);
  await collection("employee").updateMany({}, { $set: { status: "FAILED", createdAt: new Date(Date.now() - 60000), lastErrorCode: "never-store-private-detail" } });
  const response = await api("get", "/operations/audit");
  assert.equal(response.status, 503);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.producers.employees.failed, 1);
  assert.equal(response.body.producers.employees.blockedStreams, 1);
  assert.ok(response.body.producers.employees.oldestOutstandingAgeMs >= 60000);
  assert.doesNotMatch(JSON.stringify(response.body), /async@example|Jamie|EMP-|never-store|eventId|leaseToken|requestId/);
});

test("heartbeat staleness is checked before TTL cleanup and stopping one worker preserves others", async () => {
  const db = mongoose.connection.db;
  const first = createAuditHeartbeat(db, "employees"), second = createAuditHeartbeat(db, "employees"), identity = createAuditHeartbeat(db, "identity");
  await assert.rejects(first.beat(), /initialized/);
  await first.stop();
  await Promise.all([first.initialize(), second.initialize(), identity.initialize()]);
  await Promise.all([first.beat(), second.beat(), identity.beat()]);
  assert.equal((await api("get", "/operations/audit")).status, 200);
  assert.equal((await getAuditDeliveryStatus(db)).producers.employees.activeWorkers, 2);
  await first.stop();
  assert.equal((await getAuditDeliveryStatus(db)).producers.employees.activeWorkers, 1);
  await db.collection("employee_audit_workers").updateMany({ status: "RUNNING" }, { $set: { seenAt: new Date(Date.now() - 31000) } });
  assert.equal(await db.collection("employee_audit_workers").countDocuments(), 2);
  assert.equal((await getAuditDeliveryStatus(db)).producers.employees.activeWorkers, 0);
  assert.equal((await api("get", "/operations/audit")).status, 503);
  const indexes = await db.collection("employee_audit_workers").listIndexes().toArray();
  assert.equal(indexes.find((index) => index.name === "audit_worker_presence").expireAfterSeconds, 86400);
});

test("read-only health creates no collections and flags expired leases and unknown states", async () => {
  const db = mongoose.connection.db;
  const untouched = db.client.db("empty_status_fixture");
  const empty = await getAuditDeliveryStatus(untouched);
  assert.equal(empty.status, "DEGRADED");
  assert.deepEqual(await untouched.listCollections().toArray(), []);
  await api("post", "/employees", "ADMIN", profile);
  await collection("employee").updateMany({}, { $set: { status: "IN_FLIGHT", leaseUntil: new Date(0) } });
  assert.equal((await getAuditDeliveryStatus(db)).producers.employees.expiredLeases, 1);
  await collection("employee").updateMany({}, { $set: { status: "never-store-unknown-state" } });
  const report = await getAuditDeliveryStatus(db);
  assert.equal(report.producers.employees.unknown, 1);
  assert.doesNotMatch(JSON.stringify(report), /never-store/);
});

test("real worker stop/restart exposes backlog, keeps the API available, and recovers history once", async () => {
  const initial = await api("post", "/employees", "ADMIN", profile);
  assert.equal(initial.status, 201);
  const firstWorker = await startWorker();
  try {
    await waitFor(async () => await AuditEvent.countDocuments() === 1);
    assert.equal((await api("get", "/operations/audit")).status, 200);
  } finally { await stop(firstWorker); }
  const next = await api("post", "/employees", "ADMIN", { ...profile, email: "later@example.com" });
  assert.equal(next.status, 201);
  assert.equal((await request(app).get("/health/ready")).status, 200);
  assert.equal((await api("get", "/operations/audit")).status, 503);
  assert.equal(await AuditEvent.countDocuments(), 1);
  const resumed = await startWorker();
  try {
    await waitFor(async () => await AuditEvent.countDocuments() === 2);
    assert.equal((await api("get", "/operations/audit")).status, 200);
    assert.equal(await collection("employee").countDocuments({ status: "DELIVERED" }), 2);
  } finally { await stop(resumed); }
});

test("sync rollback retains matching delivery identities across an independent API process", async () => {
  const child = fork(path.join(__dirname, "helpers/api-process.cjs"), [], {
    env: { ...process.env, MONGO_URI: mongo.getUri(), AUDIT_DELIVERY_MODE: "sync" }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.add(child);
  let timer;
  try {
    const [{ port }] = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => { throw new Error("Fixture API exited before startup"); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture API startup timeout")), 10000); }),
    ]);
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/employees`, { method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookies.ADMIN.join("; ") }, body: JSON.stringify(profile), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 201);
    assert.equal(await AuditEvent.countDocuments(), 1);
    await drain(await newWorker("employees"), 1);
    assert.equal(await AuditEvent.countDocuments(), 1);
  } finally { clearTimeout(timer); await stop(child); }
  assert.equal(auditDeliveryMode(undefined), "async");
  for (const mode of ["", "ASYNC", "invalid"]) assert.throws(() => auditDeliveryMode(mode), /async or sync/);
});

test("the status command is read-only, works without API credentials, and returns a failing health code", async () => {
  const run = promisify(execFile);
  const options = { cwd: backend, env: { ...process.env, MONGO_URI: mongo.getUri(), JWT_ACCESS_SECRET: "" }, timeout: 10000 };
  const { stdout } = await run(process.execPath, ["scripts/audit-status.js"], options);
  assert.equal(JSON.parse(stdout).status, "DEGRADED");
  await assert.rejects(run(process.execPath, ["scripts/audit-status.js", "--check"], options));
  for (const producer of ["employees", "identity"]) {
    const heartbeat = createAuditHeartbeat(mongoose.connection.db, producer);
    await heartbeat.initialize(); await heartbeat.beat();
  }
  assert.equal(JSON.parse((await run(process.execPath, ["scripts/audit-status.js", "--check"], options)).stdout).status, "UP");
});
