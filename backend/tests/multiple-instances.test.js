process.env.JWT_ACCESS_SECRET = "test-only-secret-with-more-than-32-characters";
process.env.CLIENT_ORIGIN = "http://localhost:3000";
const { test, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const path = require("node:path");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const Employee = require("../src/modules/employees/Employee");
const Account = require("../src/modules/identity/Account");
const { MongoRateLimitStore } = require("../src/modules/identity/rateLimitStore");
const profile = { firstName: "Jamie", lastName: "Morgan", email: "jamie@example.com" };
const password = "a long secure passphrase";
const children = [];
let mongo, endpoints, cookie;

/** Launch real HTTP workers; bounded startup and teardown prevent orphan test processes. */
function startWorker() {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(__dirname, "helpers/api-process.cjs"), [], {
      env: { ...process.env, MONGO_URI: mongo.getUri() }, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);
    let diagnostic = "";
    child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk).slice(-6000); });
    const timer = setTimeout(() => { child.kill(); reject(new Error("API worker startup timed out")); }, 20000);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`API worker exited (${code}): ${diagnostic}`)); });
    child.once("message", ({ port }) => { clearTimeout(timer); resolve(`http://127.0.0.1:${port}`); });
  });
}

async function api(worker, method, resource, body) {
  const response = await fetch(endpoints[worker] + "/api/v1" + resource, {
    method, headers: { Origin: process.env.CLIENT_ORIGIN, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
}

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  endpoints = await Promise.all([startWorker(), startWorker()]);
  await Account.create({ ...profile, role: "ADMIN", passwordHash: await bcrypt.hash(password, 4) });
  const login = await api(0, "POST", "/auth/login", { email: profile.email, password });
  assert.equal(login.status, 200);
  cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
});
beforeEach(async () => {
  await Employee.deleteMany({});
  await mongoose.connection.db.collection("authratelimits").deleteMany({});
});
after(async () => {
  await Promise.all(children.map(async (child) => {
    if (child.exitCode !== null || child.signalCode) return;
    const exited = once(child, "exit");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    if (child.connected) child.send("close"); else child.kill();
    await exited;
    clearTimeout(timer);
  }));
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

test("different processes reject reciprocal reporting cycles", async () => {
  // Repeat with distinct records so each race starts from an unrelated hierarchy.
  for (let attempt = 0; attempt < 5; attempt++) {
    const first = await Employee.create({ ...profile, email: `first-${attempt}@example.com` });
    const second = await Employee.create({ ...profile, email: `second-${attempt}@example.com` });
    const responses = await Promise.all([
      api(0, "PATCH", `/employees/${first.id}`, { managerId: second.id }),
      api(1, "PATCH", `/employees/${second.id}`, { managerId: first.id }),
    ]);
    assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 400]);
    assert.equal(responses.find(({ status }) => status === 400).body.error.code, "REPORTING_CYCLE");
  }
});

test("assignment versus manager deletion or deactivation preserves the explicit policy across processes", async () => {
  for (const action of ["delete", "INACTIVE", "TERMINATED"]) {
    const manager = await Employee.create({ ...profile, email: `${action}@example.com` });
    const report = await Employee.create({ ...profile, email: `report-${action}@example.com` });
    const [assignment, removal] = await Promise.all([
      api(0, "PATCH", `/employees/${report.id}`, { managerId: manager.id }),
      api(1, action === "delete" ? "DELETE" : "PATCH", `/employees/${manager.id}`,
        action === "delete" ? undefined : { employmentStatus: action }),
    ]);
    if (assignment.status === 200) {
      assert.equal(removal.status, 409);
      assert.equal(removal.body.error.code, "MANAGER_HAS_DIRECT_REPORTS");
      assert.equal((await Employee.findById(manager.id)).employmentStatus, "ACTIVE");
    } else {
      assert.equal(assignment.status, 400);
      assert.equal(assignment.body.error.code, action === "delete" ? "MANAGER_NOT_FOUND" : "MANAGER_UNAVAILABLE");
      assert.equal(removal.status, action === "delete" ? 204 : 200);
      assert.equal((await Employee.findById(report.id)).managerId, null);
    }
  }
});

test("failed hierarchy changes roll back the shared guard and allow later valid changes", async () => {
  const employee = await Employee.create(profile);
  // A valid no-op assignment establishes the guard without relying on test order.
  assert.equal((await api(0, "PATCH", `/employees/${employee.id}`, { managerId: null })).status, 200);
  const guards = mongoose.connection.db.collection("employee_hierarchy_guards");
  const before = await guards.findOne({ _id: "reporting-hierarchy" });
  assert.equal((await api(1, "PATCH", `/employees/${employee.id}`, { managerId: employee.id })).status, 400);
  assert.deepEqual(await guards.findOne({ _id: before._id }), before);
  assert.equal((await api(0, "DELETE", `/employees/${employee.id}`)).status, 204);
});

test("different processes capture every committed update in one ordered resource stream", async () => {
  const created = await api(0, "POST", "/employees", { ...profile, department: "Initial" });
  assert.equal(created.status, 201);
  const id = created.body.data._id;
  const responses = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    api(index % 2, "PATCH", `/employees/${id}`, { department: `Concurrent-${index}` })));
  assert.ok(responses.every(({ status }) => status === 200));
  const pending = await mongoose.connection.db.collection("employee_audit_outbox")
    .find({ "event.resource.id": id }).sort({ "event.sequence": 1 }).toArray();
  assert.deepEqual(pending.map(({ event }) => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
  const history = await mongoose.connection.db.collection("auditevents")
    .find({ "_delivery.producer": "employees", "_delivery.streamId": `EMPLOYEE:${id}` }).toArray();
  assert.equal(history.length, pending.length);
  // A stale callback snapshot could store the correct count but incorrect diffs.
  // Verify the sequence traces the actual committed state across both processes.
  let department = "Initial";
  for (const intent of pending) {
    const stored = history.find((event) => event._delivery.eventId === intent._id);
    assert.ok(stored);
    assert.equal(stored._delivery.sequence, intent.event.sequence);
    assert.deepEqual(stored.changes, intent.event.changes);
    assert.equal(intent.status, "PENDING");
    if (intent.event.action === "EMPLOYEE_CREATED") continue;
    assert.equal(intent.event.changes.length, 1);
    const change = intent.event.changes[0];
    assert.equal(change.field, "department");
    assert.equal(change.before, department);
    department = change.after;
  }
  assert.equal((await Employee.findById(id)).department, department);
});

test("login and registration share one request budget across workers", async () => {
  // Malformed registration fails before hashing; it still consumes the shared auth budget.
  const responses = await Promise.all(Array.from({ length: 21 }, (_, index) =>
    api(index % 2, "POST", "/auth/register", {})));
  assert.equal(responses.filter(({ status }) => status === 400).length, 20);
  assert.equal(responses.filter(({ status }) => status === 429).length, 1);
  assert.equal((await api(1, "POST", "/auth/login", { email: profile.email, password })).status, 429);
  const record = await mongoose.connection.db.collection("authratelimits").findOne();
  assert.doesNotMatch(record._id, /127\.0\.0\.1/);
});

test("expired rate limits reset before TTL cleanup; separate stores count concurrent requests", async () => {
  const stores = [new MongoRateLimitStore(), new MongoRateLimitStore()];
  stores.forEach((store) => store.init({ windowMs: 60000 }));
  await mongoose.connection.db.collection("authratelimits").insertOne({
    _id: stores[0].key("fixture"), totalHits: 99, resetTime: new Date(0),
  });
  const counts = await Promise.all(Array.from({ length: 12 }, (_, index) => stores[index % 2].increment("fixture")));
  assert.deepEqual(counts.map(({ totalHits }) => totalHits).sort((a, b) => a - b), Array.from({ length: 12 }, (_, index) => index + 1));
  await stores[1].resetKey("fixture");
  assert.equal((await stores[0].increment("fixture")).totalHits, 1);
});

test("rate-limit storage failures prevent authentication handlers from running", async () => {
  const request = require("supertest");
  const app = require("../src/app");
  const broken = mock.method(mongoose.model("AuthRateLimit").collection, "findOneAndUpdate", async () => {
    throw new Error("Fixture rate-limit storage failure");
  });
  try {
    // A valid registration would persist an account if the limiter failed open.
    const response = await request(app).post("/api/v1/auth/register")
      .set("Origin", process.env.CLIENT_ORIGIN).send({ ...profile, email: "blocked@example.com", password });
    assert.equal(response.status, 500);
    assert.equal(await Account.exists({ email: "blocked@example.com" }), null);
    assert.doesNotMatch(JSON.stringify(response.body), /Fixture rate-limit storage failure/);
  } finally { broken.mock.restore(); }
});
