const { test, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { createAuditConsumer } = require("../src/modules/audit");
const { prepareAuditEvent } = require("../src/contracts/auditEvent");

const actorId = "abcdefabcdefabcdefabcdef";
const resourceId = "123456789012345678901234";
const eventId = "00000000-0000-4000-8000-000000000001";
const occurredAt = "2026-01-01T00:00:00.000Z";
function envelope(producer = "employees", overrides = {}) {
  return { ...prepareAuditEvent({
    action: producer === "employees" ? "EMPLOYEE_UPDATED" : "AUTH_LOGIN",
    requestId: "consumer-test",
    actor: { id: actorId, firstName: "Jamie", lastName: "Morgan", email: "jamie@example.com", role: "HR_MANAGER" },
    resource: { type: producer === "employees" ? "EMPLOYEE" : "ACCOUNT", id: producer === "employees" ? resourceId : actorId, label: "Fixture" },
    changes: [],
  }, { producer, eventId, occurredAt }), sequence: 1, ...overrides };
}
const employees = { producer: "employees" };
let mongo, first, second, consumer, other, events;
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  // Use separate MongoClients so duplicate handling cannot rely on process memory
  // or a shared connection's causal session when another receiver wins the insert.
  [first, second] = await Promise.all([mongoose.createConnection(mongo.getUri()).asPromise(), mongoose.createConnection(mongo.getUri()).asPromise()]);
});
beforeEach(async () => {
  await first.db.dropDatabase();
  consumer = createAuditConsumer(first.db);
  other = createAuditConsumer(second.db);
  events = first.db.collection("auditevents");
  await Promise.all([consumer.initialize(), other.initialize()]);
});
after(async () => { await Promise.all([first?.close(), second?.close()]); if (mongo) await mongo.stop(); });

test("consumer initialization is explicit, repeatable, and preserves legacy history", async () => {
  await first.db.dropDatabase();
  consumer = createAuditConsumer(first.db);
  other = createAuditConsumer(second.db);
  await assert.rejects(consumer.consume(envelope(), employees), /must be initialized/);
  assert.deepEqual(await first.db.listCollections().toArray(), []);
  const legacy = [1, 2].map((index) => ({ _id: new mongoose.Types.ObjectId(), action: "AUTH_LOGIN_FAILED", actor: null,
    resource: { type: "ACCOUNT", id: null, label: "" }, changes: [], requestId: `legacy-${index}`, occurredAt: new Date(occurredAt) }));
  await events.insertMany(legacy);
  await Promise.all([consumer.initialize(), other.initialize()]);
  await consumer.initialize();
  assert.deepEqual(await events.find().sort({ requestId: 1 }).toArray(), legacy);
  const indexes = await events.listIndexes().toArray();
  for (const name of ["audit_delivery_identity", "audit_delivery_sequence"]) {
    const index = indexes.find((candidate) => candidate.name === name);
    assert.equal(index.unique, true);
    assert.deepEqual(index.partialFilterExpression, { "_delivery.eventId": { $type: "string" } });
  }
  assert.ok(indexes.every((index) => index.expireAfterSeconds === undefined));
  assert.deepEqual((await first.db.listCollections().toArray()).map(({ name }) => name), ["auditevents"]);
});

test("delivery retains occurrence time and snapshots and survives reconnecting", async () => {
  const input = envelope("employees", { changes: [{ field: "department", before: "Engineering", after: "Platform" }] });
  const expected = structuredClone(input);
  const pending = consumer.consume(input, employees);
  input.actor.firstName = "Changed";
  input.resource.label = "Changed";
  input.changes[0].after = "Changed";
  const result = await pending;
  assert.equal(result.duplicate, false);
  const reconnected = await mongoose.createConnection(mongo.getUri()).asPromise();
  try {
    const resumed = createAuditConsumer(reconnected.db);
    await resumed.initialize();
    assert.deepEqual(await resumed.consume(expected, employees), { ...result, duplicate: true });
    const stored = await reconnected.db.collection("auditevents").findOne({ _id: new mongoose.Types.ObjectId(result.auditId) });
    assert.equal(stored.actor.firstName, "Jamie");
    assert.equal(stored.actor.id.toHexString(), actorId);
    assert.equal(stored.resource.id.toHexString(), resourceId);
    assert.equal(stored.resource.label, "Fixture");
    assert.deepEqual(stored.changes, expected.changes);
    assert.equal(stored.occurredAt.toISOString(), occurredAt);
    assert.equal(stored._delivery.eventId, eventId);
    assert.equal(stored._delivery.sequence, 1);
    assert.match(stored._delivery.fingerprint, /^[a-f0-9]{64}$/);
  } finally { await reconnected.close(); }
});

test("concurrent deliveries through independent clients record history exactly once", async () => {
  const results = await Promise.all(Array.from({ length: 24 }, (_, index) => (index % 2 ? other : consumer).consume(envelope(), employees)));
  assert.equal(results.filter((result) => !result.duplicate).length, 1);
  assert.equal(new Set(results.map((result) => result.auditId)).size, 1);
  assert.equal(await events.countDocuments(), 1);
  // Reverse JSON keys at every depth while preserving values; wire object key order
  // and hexadecimal ID case do not change the identity or immutable event content.
  const reverseKeys = (value) => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)])) : value;
  const canonicalRetry = reverseKeys(envelope());
  canonicalRetry.actor.id = actorId.toUpperCase();
  assert.deepEqual(await other.consume(canonicalRetry, employees), { auditId: results[0].auditId, duplicate: true });
});

test("reusing an event ID with changed content or metadata is a conflict, never an overwrite", async () => {
  await consumer.consume(envelope(), employees);
  const original = await events.findOne();
  for (const changed of [
    { action: "EMPLOYEE_DELETED" }, { requestId: "different-request" }, { sequence: 2 },
    { occurredAt: "2026-01-02T00:00:00.000Z" },
    { actor: { ...envelope().actor, role: "ADMIN" } },
    { resource: { ...envelope().resource, id: "111111111111111111111111" } },
    { changes: [{ field: "department", before: null, after: "Changed" }] },
  ]) await assert.rejects(other.consume(envelope("employees", changed), employees), { code: "AUDIT_DELIVERY_CONFLICT", reason: "EVENT_ID_REUSED" });
  assert.deepEqual(await events.findOne(), original);
  assert.equal(await events.countDocuments(), 1);
});

test("different event IDs cannot reuse a stream position; gaps and out-of-order arrivals remain durable", async () => {
  await consumer.consume(envelope("employees", { sequence: 2 }), employees);
  await assert.rejects(other.consume(envelope("employees", { eventId: "00000000-0000-4000-8000-000000000002", sequence: 2 }), employees),
    { code: "AUDIT_DELIVERY_CONFLICT", reason: "STREAM_SEQUENCE_REUSED" });
  await other.consume(envelope("employees", { eventId: "00000000-0000-4000-8000-000000000003", sequence: 1 }), employees);
  await other.consume(envelope("employees", { eventId: "00000000-0000-4000-8000-000000000004", sequence: 4 }), employees);
  await consumer.consume(envelope("employees", { eventId: "00000000-0000-4000-8000-000000000005",
    resource: { ...envelope().resource, id: "111111111111111111111111" }, sequence: 2 }), employees);
  assert.equal(await events.countDocuments(), 4);
});

test("producer identities are independent and anonymous failed logins have separate streams", async () => {
  await consumer.consume(envelope(), employees);
  await other.consume(envelope("identity"), { producer: "identity" });
  for (const id of ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"]) {
    const input = { ...prepareAuditEvent({ action: "AUTH_LOGIN_FAILED", actor: null,
      resource: { type: "ACCOUNT", id: null, label: "" }, requestId: "consumer-test" }, { producer: "identity", eventId: id, occurredAt }), sequence: 1 };
    const result = await consumer.consume(input, { producer: "identity" });
    assert.deepEqual(await other.consume(input, { producer: "identity" }), { ...result, duplicate: true });
  }
  assert.equal(await events.countDocuments(), 4);
  const failed = await events.find({ action: "AUTH_LOGIN_FAILED" }).toArray();
  assert.equal(new Set(failed.map((event) => event._delivery.streamId)).size, 2);
  assert.ok(failed.every((event) => event.actor === null && event.resource.id === null && event.resource.label === ""));
});

test("invalid, unsupported, or mismatched-source deliveries make no writes", async () => {
  for (const input of [
    { ...envelope(), schemaVersion: 2 }, { ...envelope(), sequence: 0 },
    { ...envelope(), changes: new Array(1) }, { ...envelope(), password: "fixture-only" },
    { ...envelope(), eventId: undefined }, { ...envelope(), occurredAt: undefined },
  ]) await assert.rejects(consumer.consume(input, employees), TypeError);
  await assert.rejects(consumer.consume(envelope(), { producer: "identity" }), /trusted source/);
  await assert.rejects(consumer.consume(envelope()), /trusted source/);
  assert.equal(await events.countDocuments(), 0);
});

test("an index initialization failure leaves the consumer closed to deliveries", async () => {
  await first.db.dropDatabase();
  // Existing duplicate metadata must be reviewed; startup cannot delete history
  // or continue accepting deliveries without the uniqueness guarantee.
  await events.insertMany([1, 2].map((index) => ({ requestId: `corrupt-${index}`,
    _delivery: { producer: "employees", eventId, streamId: `EMPLOYEE:${resourceId}`, sequence: index } })));
  consumer = createAuditConsumer(first.db);
  await assert.rejects(consumer.initialize(), { code: 11000 });
  await assert.rejects(consumer.consume(envelope(), employees), /must be initialized/);
  assert.equal(await events.countDocuments(), 2);
});

test("failed writes remain retryable without leaving a deduplication marker", async () => {
  const unavailable = mock.method(events.constructor.prototype, "insertOne", async () => { throw new Error("Fixture storage unavailable"); });
  try { await assert.rejects(consumer.consume(envelope(), employees), /Fixture storage unavailable/); }
  finally { unavailable.mock.restore(); }
  assert.equal(await events.countDocuments(), 0);
  assert.equal((await consumer.consume(envelope(), employees)).duplicate, false);
  assert.equal((await other.consume(envelope(), employees)).duplicate, true);
});

test("a lost acknowledgment after persistence is safe to retry", async () => {
  const insertOne = events.constructor.prototype.insertOne;
  const lost = mock.method(events.constructor.prototype, "insertOne", async function (...args) {
    await insertOne.apply(this, args);
    throw new Error("Fixture acknowledgment lost");
  });
  try { await assert.rejects(consumer.consume(envelope(), employees), /Fixture acknowledgment lost/); }
  finally { lost.mock.restore(); }
  assert.equal(await events.countDocuments(), 1);
  assert.equal((await other.consume(envelope(), employees)).duplicate, true);
  assert.equal(await events.countDocuments(), 1);
});

test("an unconfirmed duplicate is never acknowledged as successful delivery", async () => {
  // Simulate uniqueness winning ahead of majority visibility. A retry can proceed
  // after the competing write commits or rolls back; the receiver must not guess.
  const pending = mock.method(events.constructor.prototype, "insertOne", async () => { throw Object.assign(new Error("Fixture pending duplicate"), { code: 11000 }); });
  try { await assert.rejects(consumer.consume(envelope(), employees), /Fixture pending duplicate/); }
  finally { pending.mock.restore(); }
  assert.equal(await events.countDocuments(), 0);
  assert.equal((await other.consume(envelope(), employees)).duplicate, false);
});
