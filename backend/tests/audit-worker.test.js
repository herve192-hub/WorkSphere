const { test, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const { execFile, fork, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { once } = require("node:events");
const path = require("node:path");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { createAuditOutbox, createAuditWorker } = require("../src/outbox");
const { createAuditConsumer } = require("../src/modules/audit");
const run = promisify(execFile);
const actorId = "abcdefabcdefabcdefabcdef";
const resourceId = "123456789012345678901234";
const anotherId = "111111111111111111111111";
const backend = path.resolve(__dirname, "..");
let mongo, first, second, outbox, events, receiver;
const payload = (id = resourceId) => ({ action: "EMPLOYEE_UPDATED", requestId: "worker-test",
  actor: { id: actorId, firstName: "Jamie", lastName: "Morgan", email: "jamie@example.com", role: "HR_MANAGER" },
  resource: { type: "EMPLOYEE", id, label: "Fixture" }, changes: [],
});
const consume = (event, context) => receiver.consume(event, context);
async function enqueue(id = resourceId) {
  return first.transaction((session) => outbox.enqueue(payload(id), { session }), { writeConcern: { w: "majority" } });
}
async function worker(deliver = consume, options = {}, connection = first) {
  const instance = createAuditWorker(connection.db, "employees", deliver, options);
  await instance.initialize();
  return instance;
}
const forceReady = (eventId) => events.updateOne({ _id: eventId }, { $set: { availableAt: new Date(0), leaseUntil: new Date(0) } });
const rows = () => first.db.collection("auditevents").countDocuments();
const cli = (name, args) => run(process.execPath, [`scripts/${name}.js`, ...args], {
  cwd: backend, env: { ...process.env, MONGO_URI: mongo.getUri(), JWT_ACCESS_SECRET: "" }, timeout: 15000,
});
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  [first, second] = await Promise.all([mongoose.createConnection(mongo.getUri()).asPromise(), mongoose.createConnection(mongo.getUri()).asPromise()]);
});
beforeEach(async () => {
  await first.db.dropDatabase();
  outbox = createAuditOutbox(first.db, "employees");
  await outbox.initialize();
  events = first.db.collection("employee_audit_outbox");
  receiver = createAuditConsumer(second.db);
  await receiver.initialize();
});
after(async () => { await Promise.all([first?.close(), second?.close()]); if (mongo) await mongo.stop(); });

test("worker initialization is explicit and invalid limits fail before writes", async () => {
  await first.db.dropDatabase();
  const instance = createAuditWorker(first.db, "employees", consume);
  await assert.rejects(instance.deliverNext(), /must be initialized/);
  await assert.rejects(instance.replay("invalid"), /must be initialized/);
  for (const options of [{ maxAttempts: 0 }, { maxAttempts: 101 }, { leaseMs: 1 }, { deliveryTimeoutMs: 30000 },
    { retryBaseMs: 100, retryMaxMs: 10 }, { retryMaxMs: Infinity }, { unknown: 1 }, null])
    assert.throws(() => createAuditWorker(first.db, "employees", consume, options), TypeError);
  assert.throws(() => createAuditWorker(first.db, "unknown", consume), TypeError);
  assert.throws(() => createAuditWorker(first.db, "employees", null), TypeError);
  assert.deepEqual(await first.db.listCollections().toArray(), []);
  const other = createAuditWorker(second.db, "employees", consume);
  await Promise.all([instance.initialize(), other.initialize()]);
  assert.deepEqual(await instance.deliverNext(), { status: "IDLE" });
});

test("delivery acknowledges durable history and retains the original envelope without TTL", async () => {
  const event = await enqueue();
  const instance = await worker();
  assert.deepEqual(await instance.deliverNext(), { status: "DELIVERED", eventId: event.eventId });
  const stored = await events.findOne({ _id: event.eventId });
  assert.deepEqual(stored.event, event);
  assert.equal(stored.attempts, 1);
  assert.equal(stored.totalAttempts, 1);
  assert.ok(stored.deliveredAt instanceof Date);
  assert.equal(stored.leaseToken, undefined);
  assert.equal(stored.leaseUntil, undefined);
  assert.equal((await first.db.collection("auditevents").findOne())._id.toHexString(), stored.auditId);
  assert.equal(await rows(), 1);
  assert.deepEqual(await instance.deliverNext(), { status: "IDLE" });
  for (const name of ["employee_audit_outbox", "employee_audit_sequences"])
    assert.ok((await first.db.collection(name).listIndexes().toArray()).every((index) => index.expireAfterSeconds === undefined));
});

test("existing immediate history is acknowledged without creating another row", async () => {
  const event = await enqueue();
  const immediate = await receiver.consume(event, { producer: "employees" });
  const instance = await worker();
  assert.equal((await instance.deliverNext()).status, "DELIVERED");
  assert.equal((await events.findOne()).auditId, immediate.auditId);
  assert.equal(await rows(), 1);
});

test("independent clients claim one event once under contention", async () => {
  const event = await enqueue();
  let deliveries = 0;
  const deliver = async (...args) => { deliveries++; return consume(...args); };
  const workers = await Promise.all([worker(deliver), worker(deliver, {}, second)]);
  const results = await Promise.all(Array.from({ length: 24 }, (_, index) => workers[index % 2].deliverNext()));
  assert.equal(results.filter((result) => result.status === "DELIVERED").length, 1);
  assert.ok(results.every((result) => ["DELIVERED", "IDLE"].includes(result.status)));
  assert.equal(deliveries, 1);
  assert.equal((await events.findOne({ _id: event.eventId })).attempts, 1);
  assert.equal(await rows(), 1);
});

test("retry backoff is capped and attempt exhaustion retains the event without sensitive errors", async () => {
  const event = await enqueue();
  const instance = await worker(async () => { throw new Error("never-store-credential-or-URI"); }, { maxAttempts: 4, retryBaseMs: 1000, retryMaxMs: 1500 });
  for (let attempt = 1; attempt <= 4; attempt++) {
    const result = await instance.deliverNext();
    assert.equal(result.status, attempt === 4 ? "FAILED" : "RETRY");
    const stored = await events.findOne();
    assert.equal(stored.attempts, attempt);
    assert.equal(stored.availableAt - stored.lastFailureAt, attempt === 1 ? 1000 : 1500);
    assert.equal(stored.lastErrorCode, "DELIVERY_FAILED");
    assert.doesNotMatch(JSON.stringify(stored), /never-store/);
    assert.deepEqual(stored.event, event);
    assert.equal((await instance.deliverNext()).status, "IDLE");
    if (attempt < 4) await forceReady(event.eventId);
  }
  assert.equal(await rows(), 0);
});

test("a failed head blocks later stream events while unrelated resources continue; replay preserves identity", async () => {
  const initial = await enqueue();
  const next = await enqueue();
  const unrelated = await enqueue(anotherId);
  const broken = await worker(async () => { throw new Error("Fixture receiver outage"); }, { maxAttempts: 1 });
  assert.equal((await broken.deliverNext()).status, "FAILED");
  const healthy = await worker();
  assert.deepEqual(await healthy.deliverNext(), { status: "DELIVERED", eventId: unrelated.eventId });
  assert.equal((await healthy.deliverNext()).status, "IDLE");
  assert.equal((await events.findOne({ _id: next.eventId })).attempts, 0);
  const replays = await Promise.all([healthy.replay(initial.eventId), broken.replay(initial.eventId)]);
  assert.equal(replays.filter((result) => result.replayed).length, 1);
  const replayed = await events.findOne({ _id: initial.eventId });
  assert.deepEqual(replayed.event, initial);
  assert.equal(replayed.attempts, 0);
  assert.equal(replayed.totalAttempts, 1);
  assert.equal(replayed.replayCount, 1);
  assert.equal(replayed.lastErrorCode, "DELIVERY_FAILED");
  assert.deepEqual(await healthy.deliverNext(), { status: "DELIVERED", eventId: initial.eventId });
  assert.deepEqual(await healthy.deliverNext(), { status: "DELIVERED", eventId: next.eventId });
  assert.equal((await events.findOne({ _id: initial.eventId })).totalAttempts, 2);
  assert.deepEqual(await healthy.replay(initial.eventId), { replayed: false });
  assert.deepEqual(await healthy.replay("00000000-0000-4000-8000-000000000099"), { replayed: false });
  await assert.rejects(healthy.replay("invalid"), TypeError);
});

test("an active lease blocks its stream and an expired owner's late acknowledgment is fenced", async () => {
  const event = await enqueue();
  const next = await enqueue();
  let release, entered;
  const gate = new Promise((resolve) => { entered = resolve; });
  const slow = await worker(async (input, context) => {
    const result = await consume(input, context);
    entered();
    await new Promise((resolve) => { release = resolve; });
    return result;
  });
  const waiting = slow.deliverNext();
  try {
    await gate;
    const lease = await events.findOne({ _id: event.eventId });
    assert.equal(lease.leaseUntil - lease.lastAttemptAt, 30000);
    const healthy = await worker(consume, {}, second);
    assert.equal((await healthy.deliverNext()).status, "IDLE");
    assert.deepEqual(await healthy.replay(event.eventId), { replayed: false });
    await forceReady(event.eventId);
    assert.deepEqual(await healthy.deliverNext(), { status: "DELIVERED", eventId: event.eventId });
    const settled = await events.findOne({ _id: event.eventId });
    release();
    assert.equal((await waiting).status, "LEASE_LOST");
    assert.deepEqual(await events.findOne({ _id: event.eventId }), settled);
    assert.equal(settled.attempts, 2);
    assert.equal(await rows(), 1);
    assert.deepEqual(await healthy.deliverNext(), { status: "DELIVERED", eventId: next.eventId });
  } finally { release?.(); await waiting; }
});

test("delivery timeout requests abort and late completion remains safe to retry", async () => {
  const event = await enqueue();
  let signal, finish;
  const instance = await worker((input, context) => {
    signal = context.signal;
    return new Promise((resolve, reject) => { finish = () => consume(input, context).then(resolve, reject); });
  }, { leaseMs: 1000, deliveryTimeoutMs: 50 });
  assert.deepEqual(await instance.deliverNext(), { status: "RETRY", eventId: event.eventId, code: "DELIVERY_TIMEOUT" });
  assert.equal(signal.aborted, true);
  await forceReady(event.eventId);
  const healthy = await worker();
  assert.equal((await healthy.deliverNext()).status, "DELIVERED");
  await finish();
  assert.equal(await rows(), 1);
  assert.equal((await events.findOne()).status, "DELIVERED");
});

test("invalid envelopes and receiver conflicts fail without overwriting history", async () => {
  const event = await enqueue();
  let calls = 0;
  const instance = await worker(async (...args) => { calls++; return consume(...args); });
  await events.updateOne({ _id: event.eventId }, { $set: { "event.schemaVersion": 2 } });
  assert.deepEqual(await instance.deliverNext(), { status: "FAILED", eventId: event.eventId, code: "INVALID_EVENT" });
  assert.equal(calls, 0);
  await events.updateOne({ _id: event.eventId }, { $set: { "event.schemaVersion": 1 } });
  const original = await receiver.consume({ ...event, requestId: "original-request" }, { producer: "employees" });
  await instance.replay(event.eventId);
  assert.deepEqual(await instance.deliverNext(), { status: "FAILED", eventId: event.eventId, code: "DELIVERY_CONFLICT" });
  assert.equal((await first.db.collection("auditevents").findOne())._id.toHexString(), original.auditId);
  assert.equal(await rows(), 1);
});

test("an invalid acknowledgment cannot mark an event delivered", async () => {
  const event = await enqueue();
  const instance = await worker(async () => ({ auditId: "invalid", duplicate: false }), { maxAttempts: 1 });
  assert.deepEqual(await instance.deliverNext(), { status: "FAILED", eventId: event.eventId, code: "INVALID_ACKNOWLEDGMENT" });
  assert.equal((await events.findOne()).auditId, undefined);
});

test("a crash on the final allowed attempt becomes FAILED without exceeding the delivery budget", async () => {
  const event = await enqueue();
  await events.updateOne({ _id: event.eventId }, { $set: { status: "IN_FLIGHT", attempts: 5, totalAttempts: 5,
    leaseToken: "expired-fixture", leaseUntil: new Date(0) } });
  let calls = 0;
  const instance = await worker(async () => { calls++; return { auditId: actorId, duplicate: false }; });
  assert.deepEqual(await instance.deliverNext(), { status: "FAILED", eventId: event.eventId, code: "ATTEMPTS_EXHAUSTED" });
  assert.equal(calls, 0);
  assert.equal((await events.findOne()).attempts, 5);
  assert.equal((await events.findOne()).totalAttempts, 5);
});

test("acknowledgment storage errors preserve recoverability before or after the write commits", async () => {
  for (const boundary of ["before", "after"]) {
    const event = await enqueue(boundary === "before" ? resourceId : anotherId);
    const instance = await worker();
    const prototype = events.constructor.prototype;
    const updateOne = prototype.updateOne;
    const broken = mock.method(prototype, "updateOne", async function (...args) {
      if (this.collectionName === "employee_audit_outbox" && args[1]?.[0]?.$set?.status === "DELIVERED") {
        if (boundary === "after") await updateOne.apply(this, args);
        throw new Error("Fixture acknowledgment storage failure");
      }
      return updateOne.apply(this, args);
    });
    try { await assert.rejects(instance.deliverNext(), /Fixture acknowledgment storage failure/); }
    finally { broken.mock.restore(); }
    const stored = await events.findOne({ _id: event.eventId });
    assert.equal(stored.status, boundary === "before" ? "IN_FLIGHT" : "DELIVERED");
    if (boundary === "before") {
      await forceReady(event.eventId);
      assert.equal((await instance.deliverNext()).status, "DELIVERED");
    } else assert.equal((await instance.deliverNext()).status, "IDLE");
  }
  assert.equal(await rows(), 2);
});

test("killed worker processes recover before delivery and after insertion without duplicate history", async () => {
  for (const boundary of ["before-delivery", "after-delivery"]) {
    const event = await enqueue();
    const child = fork(path.join(__dirname, "helpers/audit-worker-process.cjs"), [], {
      env: { ...process.env, MONGO_URI: mongo.getUri(), CRASH_BOUNDARY: boundary }, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const exited = once(child, "exit");
    let timer;
    try {
      const claimed = await Promise.race([
        once(child, "message").then(([message]) => message),
        exited.then(() => { throw new Error("Fixture worker exited before claiming"); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture worker startup timeout")), 10000); }),
      ]);
      assert.equal(claimed.claimed, event.eventId);
      child.kill("SIGKILL");
      await exited;
      assert.equal((await events.findOne({ _id: event.eventId })).status, "IN_FLIGHT");
      // Advance the persisted deadline to model elapsed server time after a crash
      // without making the suite wait thirty seconds for each production lease.
      await forceReady(event.eventId);
      const resumed = await worker(consume, {}, second);
      assert.equal((await resumed.deliverNext()).status, "DELIVERED");
      const stored = await events.findOne({ _id: event.eventId });
      if (claimed.auditId) assert.equal(stored.auditId, claimed.auditId);
      assert.equal(stored.attempts, 2);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
      await exited;
    }
  }
  assert.equal(await rows(), 2);
});

test("the standalone command delivers both producers without API credentials", async () => {
  const event = await enqueue();
  const identity = createAuditOutbox(first.db, "identity");
  await identity.initialize();
  await first.transaction((session) => identity.enqueue({ action: "AUTH_LOGIN_FAILED", actor: null,
    resource: { type: "ACCOUNT", id: null, label: "" }, requestId: "worker-cli" }, { session }), { writeConcern: { w: "majority" } });
  const { stdout, stderr } = await cli("audit-worker", ["--once"]);
  assert.equal(stderr, "");
  const results = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(results.filter((result) => result.status === "DELIVERED").length, 2);
  assert.equal((await events.findOne({ _id: event.eventId })).status, "DELIVERED");
  assert.equal(await rows(), 2);
});

test("the standalone worker exits gracefully on SIGTERM while idle", async () => {
  const child = spawn(process.execPath, ["scripts/audit-worker.js"], {
    cwd: backend, env: { ...process.env, MONGO_URI: mongo.getUri(), JWT_ACCESS_SECRET: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let timer, output = "";
  try {
    await Promise.race([
      new Promise((resolve) => child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes('"status":"READY"')) resolve();
      })),
      exited.then(() => { throw new Error("Worker exited before startup"); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Worker startup timeout")), 10000); }),
    ]);
    child.kill("SIGTERM");
    const [code, signal] = await exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    await exited;
  }
});

test("operator replay requires explicit apply and only resets a FAILED event", async () => {
  const event = await enqueue();
  const broken = await worker(async () => { throw new Error("Fixture unavailable"); }, { maxAttempts: 1 });
  await broken.deliverNext();
  await assert.rejects(cli("replay-audit", ["--producer", "employees", "--event-id", event.eventId]));
  assert.equal((await events.findOne()).status, "FAILED");
  const { stdout } = await cli("replay-audit", ["--producer", "employees", "--event-id", event.eventId, "--apply"]);
  assert.equal(JSON.parse(stdout).replayed, true);
  assert.equal((await events.findOne()).status, "PENDING");
  await assert.rejects(cli("replay-audit", ["--producer", "employees", "--event-id", event.eventId, "--apply"]));
  for (const args of [["--latest"], ["--once", "--once"]]) await assert.rejects(cli("audit-worker", args));
  assert.match((await cli("audit-worker", ["--help"])).stdout, /Usage:/);
  assert.match((await cli("replay-audit", ["--help"])).stdout, /--apply/);
});
