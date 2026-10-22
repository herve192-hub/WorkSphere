const { test, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes } = require("node:crypto");
const mongoose = require("mongoose");
const { MongoClient, ObjectId } = mongoose.mongo;
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { createAuditConsumer, createAuditReader } = require("../src/modules/audit");
const { prepareAuditEvent } = require("../src/contracts/auditEvent");
const { loadContract, assertResponse } = require("./helpers/contract");

const auditDatabase = "audit_private", businessDatabase = "business_private";
const actorId = "abcdefabcdefabcdefabcdef", resourceId = "123456789012345678901234";
const passwords = { root: randomBytes(32).toString("hex"), writer: randomBytes(32).toString("hex"), reader: randomBytes(32).toString("hex") };
let mongo, root, writer, readerClient, reader, consumer;
function client(user, password) {
  return new MongoClient(mongo.getUri(), {
    auth: { username: user, password }, authSource: "admin", serverSelectionTimeoutMS: 5000,
  });
}
function envelope(sequence = 1, overrides = {}) {
  return { ...prepareAuditEvent({
    action: "EMPLOYEE_UPDATED", requestId: `audit-boundary-${sequence}`,
    actor: { id: actorId, firstName: "Jamie", lastName: "Morgan", email: "jamie@example.com", role: "HR_MANAGER" },
    resource: { type: "EMPLOYEE", id: resourceId, label: "Fixture .*" },
    changes: [{ field: "department", before: "Engineering", after: "Platform" }],
  }, { producer: "employees", occurredAt: "2026-01-01T23:59:59.999Z" }), sequence, ...overrides };
}
const json = (value) => JSON.parse(JSON.stringify(value));
before(async () => {
  await loadContract();
  // Authentication is essential here: separate Db handles alone cannot prove
  // that an extracted service works without account/session/outbox privileges.
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, auth: {
    enable: true, customRootName: "fixture-root", customRootPwd: passwords.root,
    keyfileContent: randomBytes(32).toString("hex"),
  } } });
  root = client("fixture-root", passwords.root);
  await root.connect();
  for (const access of ["writer", "reader"]) {
    await root.db("admin").command({ createUser: `audit-${access}`, pwd: passwords[access],
      roles: [{ role: access === "writer" ? "readWrite" : "read", db: auditDatabase }] });
  }
  writer = client("audit-writer", passwords.writer);
  readerClient = client("audit-reader", passwords.reader);
  await Promise.all([writer.connect(), readerClient.connect()]);
});
beforeEach(async () => {
  await root.db(auditDatabase).dropDatabase();
  await root.db(businessDatabase).dropDatabase();
  consumer = createAuditConsumer(writer.db(auditDatabase));
  reader = createAuditReader(readerClient.db(auditDatabase));
  assert.equal(mongoose.connection.readyState, 0, "Audit factories must not connect the API's default client");
});
after(async () => {
  await Promise.all([root?.close(), writer?.close(), readerClient?.close()]);
  if (mongo) await mongo.stop();
});

test("Audit factories and empty reads create no collections and need no API initialization", async () => {
  assert.deepEqual(await root.db(auditDatabase).listCollections().toArray(), []);
  assert.deepEqual(await reader.listEvents(), { data: [], pagination: { page: 1, limit: 20, totalItems: 0, totalPages: 0 } });
  await assert.rejects(reader.getEvent(new ObjectId().toHexString()), { status: 404, code: "AUDIT_NOT_FOUND" });
  assert.deepEqual(await root.db(auditDatabase).listCollections().toArray(), []);
  assert.deepEqual(await root.db(businessDatabase).listCollections().toArray(), []);
  assert.equal(mongoose.connection.readyState, 0);
});

test("Audit-only credentials ingest and read history while business data remains inaccessible", async () => {
  const business = root.db(businessDatabase);
  const privateAccount = { email: "private@example.com", passwordHash: "fixture-only" };
  await business.collection("accounts").insertOne(privateAccount);
  const unrelated = { _id: new ObjectId(), requestId: "never-return-business-history" };
  await business.collection("auditevents").insertOne(unrelated);
  await consumer.initialize();
  const input = envelope();
  const result = await consumer.consume(input, { producer: "employees" });
  const stored = await reader.getEvent(result.auditId);
  assert.equal(stored.requestId, input.requestId);
  assert.equal(stored.actor.id.toHexString(), actorId);
  assert.equal(stored.resource.id.toHexString(), resourceId);
  assert.equal(stored._delivery, undefined);
  assertResponse({ status: 200, body: { data: json(stored) } }, "/api/v1/audit/{id}", "get");
  assert.equal((await reader.listEvents()).pagination.totalItems, 1);
  await assert.rejects(reader.getEvent(unrelated._id.toHexString()), { status: 404, code: "AUDIT_NOT_FOUND" });
  for (const restricted of [writer, readerClient]) {
    for (const collection of ["accounts", "sessions", "employees", "employee_audit_outbox", "auditevents"])
      await assert.rejects(restricted.db(businessDatabase).collection(collection).findOne({}), { code: 13 });
  }
  await assert.rejects(readerClient.db(auditDatabase).collection("auditevents").insertOne({}), { code: 13 });
  assert.deepEqual(await business.collection("accounts").findOne({}), privateAccount);
  assert.deepEqual((await root.db(auditDatabase).listCollections().toArray()).map(({ name }) => name), ["auditevents"]);
  assert.equal(mongoose.connection.readyState, 0);
});

test("native Audit reads preserve filters, literal search, inclusive dates, and stable pagination", async () => {
  await consumer.initialize();
  const ids = [];
  for (let sequence = 1; sequence <= 3; sequence++) {
    const result = await consumer.consume(envelope(sequence), { producer: "employees" });
    ids.push(result.auditId);
  }
  await consumer.consume(envelope(4, { occurredAt: "2026-01-02T00:00:00.000Z" }), { producer: "employees" });
  const filtered = await reader.listEvents({ action: "EMPLOYEE_UPDATED", actorId: actorId.toUpperCase(), resourceId,
    resourceType: "EMPLOYEE", from: "2026-01-01", to: "2026-01-01", search: ".*", limit: "1" });
  assert.equal(filtered.pagination.totalItems, 3);
  assert.equal(filtered.pagination.totalPages, 3);
  assert.equal(filtered.data[0]._id.toHexString(), ids[2]);
  const second = await reader.listEvents({ from: "2026-01-01", to: "2026-01-01", limit: "1", page: "2" });
  assert.equal(second.data[0]._id.toHexString(), ids[1]);
  assert.equal((await reader.listEvents({ search: "^.*$" })).data.length, 0);
  assert.equal((await reader.listEvents({ actorId: "111111111111111111111111" })).data.length, 0);
  assert.equal((await reader.listEvents({ resourceId: "111111111111111111111111" })).data.length, 0);
  assert.equal((await reader.getEvent(ids[0].toUpperCase()))._id.toHexString(), ids[0]);
  assertResponse({ status: 200, body: json(filtered) }, "/api/v1/audit", "get");
});

test("reader preserves legacy and anonymous history while hiding internal fields at every level", async () => {
  const legacy = { _id: new ObjectId(), action: "AUTH_LOGIN_FAILED", actor: null,
    resource: { type: "ACCOUNT", id: null, label: "" }, changes: [], requestId: "legacy-audit", occurredAt: new Date("2025-01-01T00:00:00.000Z") };
  const events = root.db(auditDatabase).collection("auditevents");
  await events.insertOne(legacy);
  await consumer.initialize();
  assert.deepEqual(await reader.getEvent(legacy._id.toHexString()), legacy);
  const result = await consumer.consume(envelope(), { producer: "employees" });
  // Raw storage can contain future internal fields; output must retain only the
  // public contract even when a legacy importer bypasses schema validation.
  await events.updateOne({ _id: new ObjectId(result.auditId) }, { $set: {
    privateNote: "never-return-internal", "actor.privateNote": "never-return-internal",
    "resource.privateNote": "never-return-internal", "changes.0.privateNote": "never-return-internal",
  } });
  assert.doesNotMatch(JSON.stringify(await reader.getEvent(result.auditId)), /_delivery|privateNote|never-return-internal/);
  const history = await reader.listEvents();
  assert.doesNotMatch(JSON.stringify(history), /_delivery|privateNote|never-return-internal/);
  assert.equal(history.pagination.totalItems, 2);
  assertResponse({ status: 200, body: json(history) }, "/api/v1/audit", "get");
  const indexes = await events.listIndexes().toArray();
  assert.equal(indexes.length, 7); // _id, four query indexes, two delivery indexes.
  assert.ok(indexes.every((index) => index.expireAfterSeconds === undefined));
});

test("malformed queries and IDs fail before database access", async () => {
  const prototype = readerClient.db(auditDatabase).collection("auditevents").constructor.prototype;
  const reads = ["find", "findOne", "countDocuments"].map((method) => mock.method(prototype, method));
  try {
    for (const query of [{ actorId: { $ne: null } }, { action: ["AUTH_LOGIN", "AUTH_LOGOUT"] }, { $where: "true" },
      { resourceId: "invalid" }, { limit: "101" }, { page: "0" }, { from: "2026-02-31" }, { to: "2026-02-31" },
      { from: "2030-01-01", to: "2020-01-01" }, { search: "x".repeat(255) }])
      await assert.rejects(reader.listEvents(query), { status: 400, code: "VALIDATION_ERROR" });
    for (const id of ["invalid", { $ne: null }, null])
      await assert.rejects(reader.getEvent(id), { status: 400, code: "INVALID_AUDIT_ID" });
    assert.ok(reads.every((read) => read.mock.callCount() === 0));
  } finally { reads.forEach((read) => read.mock.restore()); }
});

test("a closed Audit client fails without fallback; reconnecting retains delivery identities and reads", async () => {
  await consumer.initialize();
  const event = envelope();
  const result = await consumer.consume(event, { producer: "employees" });
  const disconnected = client("audit-reader", passwords.reader);
  await disconnected.connect();
  const old = createAuditReader(disconnected.db(auditDatabase));
  assert.equal((await old.getEvent(result.auditId)).requestId, event.requestId);
  await disconnected.close();
  await assert.rejects(old.listEvents(), { name: "MongoNotConnectedError" });
  await assert.rejects(old.getEvent(result.auditId), { name: "MongoNotConnectedError" });
  const reconnected = client("audit-writer", passwords.writer);
  try {
    await reconnected.connect();
    const resumed = createAuditConsumer(reconnected.db(auditDatabase));
    await resumed.initialize();
    assert.deepEqual(await resumed.consume(event, { producer: "employees" }), { ...result, duplicate: true });
    assert.equal((await createAuditReader(reconnected.db(auditDatabase)).listEvents()).pagination.totalItems, 1);
  } finally { await reconnected.close(); }
  assert.equal(mongoose.connection.readyState, 0);
});
