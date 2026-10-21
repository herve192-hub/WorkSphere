const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { createAuditOutbox } = require("../src/outbox");

const actorId = "abcdefabcdefabcdefabcdef";
const resourceId = "123456789012345678901234";
const eventId = "00000000-0000-4000-8000-000000000001";
const occurredAt = "2026-01-01T00:00:00.000Z";
function payload(producer = "employees") {
  return {
    action: producer === "employees" ? "EMPLOYEE_UPDATED" : "AUTH_LOGIN",
    requestId: "outbox-test",
    actor: { id: actorId, firstName: "Jamie", lastName: "Morgan", email: "jamie@example.com", role: "HR_MANAGER" },
    resource: { type: producer === "employees" ? "EMPLOYEE" : "ACCOUNT", id: producer === "employees" ? resourceId : actorId, label: "Fixture" },
    changes: [],
  };
}
let mongo, first, second, outbox;
// Match the producer integration's durability requirement, rather than depending
// on a test server's configurable default write concern.
function transact(connection, operation) {
  return connection.transaction(operation, { writeConcern: { w: "majority" } });
}
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  // Distinct MongoClient instances catch accidental use of a global connection.
  [first, second] = await Promise.all([mongoose.createConnection(mongo.getUri()).asPromise(), mongoose.createConnection(mongo.getUri()).asPromise()]);
});
beforeEach(async () => {
  await first.db.dropDatabase();
  outbox = createAuditOutbox(first.db, "employees");
  await outbox.initialize();
  await first.db.createCollection("business_fixture");
});
after(async () => {
  await Promise.all([first?.close(), second?.close()]);
  if (mongo) await mongo.stop();
});

test("producer-owned initialization is explicit, repeatable, and safe across simultaneous startups", async () => {
  await first.db.dropDatabase();
  outbox = createAuditOutbox(first.db, "employees");
  const other = createAuditOutbox(second.db, "employees");
  await transact(first, async (session) => {
    await assert.rejects(outbox.enqueue(payload(), { session }), /must be initialized/);
  });
  assert.deepEqual(await first.db.listCollections().toArray(), []);
  await Promise.all([outbox.initialize(), other.initialize()]);
  const indexes = await first.db.collection("employee_audit_outbox").listIndexes().toArray();
  assert.ok(indexes.some(({ name, unique }) => name === "audit_stream_sequence" && unique));
  assert.ok(indexes.some(({ name }) => name === "audit_pending_delivery"));
  assert.ok(indexes.every((index) => index.expireAfterSeconds === undefined));
  const names = (await first.db.listCollections().toArray()).map(({ name }) => name).sort();
  assert.deepEqual(names, ["employee_audit_outbox", "employee_audit_sequences"]);
  assert.throws(() => createAuditOutbox(first.db, "audit"), TypeError);
});

test("business state and its pending audit envelope commit atomically and survive reconnecting", async () => {
  let event;
  await transact(first, async (session) => {
    await first.db.collection("business_fixture").insertOne({ _id: "change", state: "updated" }, { session });
    event = await outbox.enqueue(payload(), { session, eventId, occurredAt });
    // A different client's reads must not observe an uncommitted business change or event.
    assert.equal(await second.db.collection("business_fixture").countDocuments(), 0);
    assert.equal(await second.db.collection("employee_audit_outbox").countDocuments(), 0);
  });
  assert.equal(event.sequence, 1);
  assert.equal(event.eventId, eventId);
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.occurredAt, occurredAt);
  const reconnected = await mongoose.createConnection(mongo.getUri()).asPromise();
  try {
    const stored = await reconnected.db.collection("employee_audit_outbox").findOne({ _id: eventId });
    assert.deepEqual(stored.event, event);
    assert.equal(stored.status, "PENDING");
    assert.equal(stored.attempts, 0);
    assert.equal(stored.streamId, `EMPLOYEE:${resourceId}`);
    assert.ok(stored.createdAt instanceof Date && stored.availableAt instanceof Date);
    assert.equal((await reconnected.db.collection("business_fixture").findOne({ _id: "change" })).state, "updated");
  } finally { await reconnected.close(); }
});

test("a rollback removes both the event and sequence allocation along with the business write", async () => {
  await assert.rejects(transact(first, async (session) => {
    await first.db.collection("business_fixture").insertOne({ _id: "rolled-back" }, { session });
    await outbox.enqueue(payload(), { session, eventId });
    throw new Error("Fixture business operation failed");
  }), /Fixture business operation failed/);
  for (const name of ["business_fixture", "employee_audit_outbox", "employee_audit_sequences"])
    assert.equal(await first.db.collection(name).countDocuments(), 0);
  const committed = await transact(first, (session) => outbox.enqueue(payload(), { session, eventId }));
  assert.equal(committed.sequence, 1);
});

test("enqueue rejects missing, inactive, ended, or foreign-client transactions before making writes", async () => {
  await assert.rejects(outbox.enqueue(payload()), /active transaction/);
  const inactive = await first.startSession();
  try { await assert.rejects(outbox.enqueue(payload(), { session: inactive }), /active transaction/); }
  finally { await inactive.endSession(); }
  await assert.rejects(outbox.enqueue(payload(), { session: inactive }), /active transaction/);
  await transact(second, async (session) => {
    await assert.rejects(outbox.enqueue(payload(), { session }), /producing database client/);
  });
  assert.equal(await first.db.collection("employee_audit_outbox").countDocuments(), 0);
  assert.equal(await first.db.collection("employee_audit_sequences").countDocuments(), 0);
});

test("an outbox validation failure aborts the surrounding business transaction", async () => {
  await assert.rejects(transact(first, async (session) => {
    await first.db.collection("business_fixture").insertOne({ _id: "invalid-event" }, { session });
    await outbox.enqueue({ ...payload(), password: "fixture-only" }, { session });
  }), TypeError);
  assert.equal(await first.db.collection("business_fixture").countDocuments(), 0);
  assert.equal(await first.db.collection("employee_audit_sequences").countDocuments(), 0);
});

test("duplicate event IDs fail closed without changing the original event or committing business changes", async () => {
  await transact(first, (session) => outbox.enqueue(payload(), { session, eventId }));
  const original = await first.db.collection("employee_audit_outbox").findOne({ _id: eventId });
  await assert.rejects(transact(first, async (session) => {
    await first.db.collection("business_fixture").insertOne({ _id: "duplicate" }, { session });
    await outbox.enqueue({ ...payload(), changes: [{ field: "department", before: null, after: "Different" }] }, { session, eventId });
  }), { code: 11000 });
  assert.equal(await first.db.collection("business_fixture").countDocuments(), 0);
  assert.deepEqual(await first.db.collection("employee_audit_outbox").findOne({ _id: eventId }), original);
  const next = await transact(first, (session) => outbox.enqueue(payload(), { session }));
  assert.equal(next.sequence, 2);
});

test("independent clients allocate ordered sequences for the same stream under contention", async () => {
  const otherOutbox = createAuditOutbox(second.db, "employees");
  await otherOutbox.initialize();
  const events = await Promise.all(Array.from({ length: 20 }, (_, index) => {
    const connection = index % 2 ? second : first;
    const storage = index % 2 ? otherOutbox : outbox;
    return transact(connection, (session) => storage.enqueue(payload(), { session }));
  }));
  assert.equal(new Set(events.map((event) => event.eventId)).size, 20);
  assert.deepEqual(events.map((event) => event.sequence).sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index + 1));
  const nextResource = { ...payload(), resource: { ...payload().resource, id: "111111111111111111111111" } };
  assert.equal((await transact(first, (session) => outbox.enqueue(nextResource, { session }))).sequence, 1);
});

test("sequence exhaustion aborts the business write without persisting an unsafe number", async () => {
  await first.db.collection("employee_audit_sequences").insertOne({ _id: `EMPLOYEE:${resourceId}`, value: Number.MAX_SAFE_INTEGER });
  await assert.rejects(transact(first, async (session) => {
    await first.db.collection("business_fixture").insertOne({ _id: "exhausted" }, { session });
    await outbox.enqueue(payload(), { session });
  }), /sequence is exhausted/);
  assert.equal(await first.db.collection("business_fixture").countDocuments(), 0);
  assert.equal(await first.db.collection("employee_audit_outbox").countDocuments(), 0);
  assert.equal((await first.db.collection("employee_audit_sequences").findOne()).value, Number.MAX_SAFE_INTEGER);
});

test("identity uses its own collections and anonymous failed logins have independent streams", async () => {
  const identity = createAuditOutbox(first.db, "identity");
  await identity.initialize();
  const event = await transact(first, (session) => identity.enqueue(payload("identity"), { session }));
  assert.equal(event.producer, "identity");
  const anonymous = { action: "AUTH_LOGIN_FAILED", actor: null, resource: { type: "ACCOUNT", id: null, label: "" }, requestId: "outbox-test" };
  const failed = [];
  for (let index = 0; index < 2; index++) failed.push(await transact(first, (session) => identity.enqueue(anonymous, { session })));
  assert.deepEqual(failed.map((event) => event.sequence), [1, 1]);
  assert.notEqual(failed[0].eventId, failed[1].eventId);
  assert.equal(await first.db.collection("identity_audit_outbox").countDocuments(), 3);
  assert.equal(await first.db.collection("employee_audit_outbox").countDocuments(), 0);
  const sequenceIndexes = await first.db.collection("identity_audit_sequences").listIndexes().toArray();
  assert.ok(sequenceIndexes.every((index) => index.expireAfterSeconds === undefined));
});
