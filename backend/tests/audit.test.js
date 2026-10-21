process.env.JWT_ACCESS_SECRET = "test-only-secret-with-more-than-32-characters";
process.env.CLIENT_ORIGIN = "http://localhost:3000";
const { test, before, after, beforeEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const request = require("supertest");
const app = require("../src/app");
const Account = require("../src/modules/identity/Account");
const Employee = require("../src/modules/employees/Employee");
const Session = require("../src/modules/identity/Session");
const AuditEvent = require("../src/modules/audit/AuditEvent");
const { createAuditConsumer, appendEnvelope } = require("../src/modules/audit");
const { prepareAuditEvent, validateAuditEnvelope } = require("../src/contracts/auditEvent");
const { loadContract, assertResponse } = require("./helpers/contract");
const origin = "http://localhost:3000";
const password = "a long secure passphrase";
const person = { firstName: "Jamie", lastName: "Morgan", email: "jamie@example.com", department: "Engineering" };
const accounts = {}, cookies = {};
let mongo;
const responseCookies = (res) => res.headers["set-cookie"].map((cookie) => cookie.split(";")[0]);

async function api(method, path, role = "ADMIN", body) {
  const req = request(app)[method]("/api/v1" + path).set("Origin", origin).set("X-Request-Id", "audit-test-request");
  if (role) req.set("Cookie", cookies[role]);
  const res = await (body === undefined ? req : req.send(body));
  const contractPath = "/api/v1" + path.split("?")[0].replace(/\/(?:[a-f\d]{24}|bad-id)$/i, "/{id}");
  if (["get", "post", "patch", "delete"].includes(method) && !(path.startsWith("/audit") && method !== "get"))
    assertResponse(res, contractPath, method);
  return res;
}

/** Check the live producer/consumer contract, not only separate storage primitives. */
async function assertCaptured(producer, count) {
  const collection = producer === "employees" ? "employee_audit_outbox" : "identity_audit_outbox";
  const pending = await mongoose.connection.db.collection(collection).find().sort({ "event.sequence": 1 }).toArray();
  assert.equal(pending.length, count);
  const receiver = createAuditConsumer(mongoose.connection.db);
  await receiver.initialize();
  const before = await AuditEvent.countDocuments();
  for (const intent of pending) {
    assert.deepEqual(validateAuditEnvelope(intent.event), intent.event);
    assert.equal(intent.status, "PENDING");
    assert.equal(intent.attempts, 0);
    const stored = await AuditEvent.collection.findOne({ "_delivery.producer": producer, "_delivery.eventId": intent._id });
    assert.ok(stored, "Committed intent must already have immediate audit history");
    const { action, actor, resource, changes, requestId, occurredAt } = stored;
    assert.deepEqual(JSON.parse(JSON.stringify({ action, actor, resource, changes, requestId, occurredAt })), {
      action: intent.event.action, actor: intent.event.actor, resource: intent.event.resource,
      changes: intent.event.changes, requestId: intent.event.requestId, occurredAt: intent.event.occurredAt,
    });
    assert.equal(stored._delivery.sequence, intent.event.sequence);
    assert.equal(stored._delivery.streamId, intent.streamId);
    assert.deepEqual(await receiver.consume(intent.event, { producer }), { auditId: String(stored._id), duplicate: true });
  }
  assert.equal(await AuditEvent.countDocuments(), before);
  assert.doesNotMatch(JSON.stringify(pending), /never-store|passwordHash|tokenHash|ws_access|ws_refresh|a long secure passphrase/);
  return pending;
}

async function assertNoIntents() {
  for (const producer of ["employee", "identity"])
    for (const suffix of ["outbox", "sequences"])
      assert.equal(await mongoose.connection.db.collection(`${producer}_audit_${suffix}`).countDocuments(), 0);
}

/** Fail only the selected producer's native insert; other storage remains real. */
async function withBrokenOutbox(name, operation) {
  const prototype = mongoose.connection.db.collection(name).constructor.prototype;
  const insertOne = prototype.insertOne;
  const broken = mock.method(prototype, "insertOne", async function (...args) {
    if (this.collectionName === name) throw new Error("Fixture outbox unavailable");
    return insertOne.apply(this, args);
  });
  try { await operation(); } finally { broken.mock.restore(); }
}
before(async () => {
  await loadContract();
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all(["identity", "employees", "audit"].map((domain) => require(`../src/modules/${domain}`).initialize()));
  const passwordHash = await bcrypt.hash(password, 12);
  for (const role of ["ADMIN", "HR_MANAGER", "EMPLOYEE"]) {
    accounts[role] = await Account.create({ ...person, email: `${role.toLowerCase()}@example.com`, passwordHash, role });
    const login = await api("post", "/auth/login", null, { email: accounts[role].email, password });
    assert.equal(login.status, 200);
    cookies[role] = responseCookies(login);
  }
});
beforeEach(async () => {
  await AuditEvent.deleteMany({});
  await Employee.deleteMany({});
  await mongoose.connection.db.collection("counters").deleteMany({});
  await mongoose.connection.db.collection("authratelimits").deleteMany({});
  // History and its pending intents are one test fixture; deleting only history
  // would manufacture an outage/replay scenario unrelated to each API regression.
  for (const producer of ["employee", "identity"]) {
    await mongoose.connection.db.collection(`${producer}_audit_outbox`).deleteMany({});
    await mongoose.connection.db.collection(`${producer}_audit_sequences`).deleteMany({});
  }
});
after(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });

test("CRUD history retains actor, request, changed fields, and deleted resource without credentials", async () => {
  const created = await api("post", "/employees", "HR_MANAGER", {
    ...person, password: "never-store-this-password", passwordHash: "never-store-this-hash",
    actor: { role: "ADMIN" }, token: "never-store-this-token",
    eventId: "00000000-0000-4000-8000-000000000001", producer: "identity", sequence: 999,
    schemaVersion: 2, occurredAt: "2020-01-01T00:00:00.000Z",
  });
  assert.equal(created.status, 201);
  const id = created.body.data._id;
  assert.equal((await api("patch", `/employees/${id}`, "ADMIN", { jobTitle: "Engineer", employmentStatus: "INACTIVE" })).status, 200);
  assert.equal((await api("delete", `/employees/${id}`)).status, 204);
  assert.equal((await api("get", `/employees/${id}`)).status, 404);
  const history = await api("get", `/audit?resourceId=${id}`);
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.data.map((event) => event.action), ["EMPLOYEE_DELETED", "EMPLOYEE_UPDATED", "EMPLOYEE_CREATED"]);
  const [deleted, updated, initial] = history.body.data;
  assert.equal(initial.actor.id, String(accounts.HR_MANAGER._id));
  assert.equal(initial.actor.role, "HR_MANAGER");
  assert.equal(updated.actor.id, String(accounts.ADMIN._id));
  assert.equal(initial.requestId, "audit-test-request");
  assert.equal(deleted.resource.label, created.body.data.employeeNumber);
  assert.equal(deleted.resource.id, id);
  assert.deepEqual(updated.changes.find(({ field }) => field === "employmentStatus"), { field: "employmentStatus", before: "ACTIVE", after: "INACTIVE" });
  assert.deepEqual(updated.changes.find(({ field }) => field === "jobTitle"), { field: "jobTitle", before: "", after: "Engineer" });
  assert.deepEqual(deleted.changes.find(({ field }) => field === "email"), { field: "email", before: person.email, after: null });
  assert.doesNotMatch(JSON.stringify(history.body), /never-store|passwordHash|ws_access|ws_refresh|tokenHash/);
  const stored = await AuditEvent.findById(initial._id).lean();
  assert.equal(stored.actor.email, accounts.HR_MANAGER.email);
  await Account.updateOne({ _id: accounts.HR_MANAGER._id }, { firstName: "Renamed" });
  assert.equal((await api("get", `/audit/${initial._id}`)).body.data.actor.firstName, person.firstName);
  const pending = await assertCaptured("employees", 3);
  assert.deepEqual(pending.map(({ event }) => event.sequence), [1, 2, 3]);
  assert.deepEqual(pending.map(({ event }) => event.action), ["EMPLOYEE_CREATED", "EMPLOYEE_UPDATED", "EMPLOYEE_DELETED"]);
  assert.notEqual(pending[0].event.eventId, "00000000-0000-4000-8000-000000000001");
  assert.notEqual(pending[0].event.occurredAt, "2020-01-01T00:00:00.000Z");
});

test("audit is manager-readable, employee-restricted, and has no write/delete routes", async () => {
  const created = await api("post", "/employees", "ADMIN", person);
  assert.equal(created.status, 201);
  const event = await AuditEvent.findOne();
  for (const role of ["ADMIN", "HR_MANAGER"]) {
    assert.equal((await api("get", "/audit", role)).status, 200);
    assert.equal((await api("get", `/audit/${event.id}`, role)).status, 200);
    for (const method of ["post", "patch", "delete"])
      assert.equal((await api(method, method === "post" ? "/audit" : `/audit/${event.id}`, role, {})).status, 404);
  }
  for (const path of ["/audit", `/audit/${event.id}`]) {
    assert.equal((await api("get", path, null)).status, 401);
    assert.equal((await api("get", path, "EMPLOYEE")).status, 403);
  }
  assert.equal((await api("get", "/audit/bad-id")).status, 400);
  assert.equal((await api("get", `/audit/${new mongoose.Types.ObjectId()}`)).status, 404);
});

test("history filters, inclusive UTC dates, stable pagination, and invalid queries", async () => {
  const created = await api("post", "/employees", "ADMIN", person);
  const id = created.body.data._id;
  await api("patch", `/employees/${id}`, "HR_MANAGER", { department: "Platform" });
  const date = new Date().toISOString().slice(0, 10);
  const filtered = await api("get", `/audit?action=EMPLOYEE_CREATED&resourceType=EMPLOYEE&resourceId=${id}&actorId=${accounts.ADMIN._id}&from=${date}&to=${date}&search=EMP-`);
  assert.equal(filtered.body.pagination.totalItems, 1);
  const first = await api("get", "/audit?limit=1");
  const second = await api("get", "/audit?limit=1&page=2");
  assert.equal(first.body.pagination.totalPages, 2);
  assert.notEqual(first.body.data[0]._id, second.body.data[0]._id);
  assert.equal((await api("get", "/audit?search=.*")).body.data.length, 0);
  for (const query of ["page=0", "limit=101", "page=1abc", "action=UNKNOWN", "resourceType=UNKNOWN", "actorId=bad", "resourceId=bad", "from=2026-02-31", "to=2026-02-31", "from=2030-01-01&to=2020-01-01", "unknown=1", "action=AUTH_LOGIN&action=AUTH_LOGOUT"])
    assert.equal((await api("get", "/audit?" + query)).status, 400, query);
});

test("invalid and denied employee writes do not produce successful mutation history", async () => {
  assert.equal((await api("post", "/employees", "EMPLOYEE", person)).status, 403);
  assert.equal((await api("post", "/employees", "ADMIN", { ...person, firstName: "" })).status, 400);
  assert.equal(await AuditEvent.countDocuments(), 0);
  await assertNoIntents();
  await api("post", "/employees", "ADMIN", person);
  assert.equal((await api("post", "/employees", "ADMIN", person)).status, 409);
  assert.equal(await AuditEvent.countDocuments(), 1);
  await assertCaptured("employees", 1);
});

test("audit insertion failure rolls back create, update, and delete", async () => {
  const employee = await Employee.create(person);
  const broken = mock.method(AuditEvent.collection, "insertOne", async () => { throw new Error("Audit storage unavailable"); });
  try {
    const create = await api("post", "/employees", "ADMIN", { ...person, email: "rollback@example.com" });
    assert.equal(create.status, 500);
    assert.equal(await Employee.exists({ email: "rollback@example.com" }), null);
    assert.equal((await api("patch", `/employees/${employee.id}`, "ADMIN", { department: "Changed" })).status, 500);
    assert.equal((await Employee.findById(employee.id)).department, person.department);
    assert.equal((await api("delete", `/employees/${employee.id}`)).status, 500);
    assert.ok(await Employee.exists({ _id: employee.id }));
    assert.equal(await AuditEvent.countDocuments(), 0);
    await assertNoIntents();
  } finally { broken.mock.restore(); }
  const next = await api("post", "/employees", "ADMIN", { ...person, email: "next@example.com" });
  assert.equal(next.body.data.employeeNumber, "EMP-000003");
});

test("registration, failed login, login, refresh, and logout produce credential-free history", async () => {
  const credentials = { ...person, email: "auth-history@example.com", password };
  assert.equal((await api("post", "/auth/register", null, credentials)).status, 201);
  assert.equal((await api("post", "/auth/login", null, { ...credentials, password: "wrong-password" })).status, 401);
  const login = await api("post", "/auth/login", null, credentials);
  cookies.NEW = responseCookies(login);
  const refresh = await api("post", "/auth/refresh", "NEW");
  assert.equal(refresh.status, 200);
  cookies.NEW = responseCookies(refresh);
  assert.equal((await api("post", "/auth/logout", "NEW")).status, 204);
  const events = await AuditEvent.find().sort({ occurredAt: 1, _id: 1 }).lean();
  assert.deepEqual(events.map(({ action }) => action), ["AUTH_REGISTERED", "AUTH_LOGIN_FAILED", "AUTH_LOGIN", "AUTH_REFRESHED", "AUTH_LOGOUT"]);
  assert.equal(events[1].actor, null);
  assert.equal(events[1].resource.id, null);
  assert.equal(events[0].actor.role, "EMPLOYEE");
  assert.doesNotMatch(JSON.stringify(events), /password|tokenHash|ws_access|ws_refresh|a long secure passphrase/);
  const pending = await assertCaptured("identity", 5);
  const verified = pending.filter(({ event }) => event.actor !== null);
  assert.deepEqual(verified.map(({ event }) => event.sequence), [1, 2, 3, 4]);
  const anonymous = pending.find(({ event }) => event.action === "AUTH_LOGIN_FAILED");
  assert.deepEqual(anonymous.event.resource, { type: "ACCOUNT", id: null, label: "" });
  assert.equal(anonymous.event.actor, null);
  assert.equal(anonymous.event.sequence, 1);
});

test("audit insertion failure rolls back account and session lifecycle without issuing cookies", async () => {
  const before = await Session.countDocuments();
  const broken = mock.method(AuditEvent.collection, "insertOne", async () => { throw new Error("Audit storage unavailable"); });
  try {
    const registered = await api("post", "/auth/register", null, { ...person, email: "auth-rollback@example.com", password });
    assert.equal(registered.status, 500);
    assert.equal(await Account.exists({ email: "auth-rollback@example.com" }), null);
    const login = await api("post", "/auth/login", null, { email: accounts.ADMIN.email, password });
    assert.equal(login.status, 500);
    assert.equal(login.headers["set-cookie"], undefined);
    for (const path of ["/auth/refresh", "/auth/logout"]) {
      const failed = await api("post", path);
      assert.equal(failed.status, 500);
      assert.equal(failed.headers["set-cookie"], undefined);
      assert.equal((await api("get", "/auth/me")).status, 200);
    }
    assert.equal(await Session.countDocuments(), before);
    assert.equal(await AuditEvent.countDocuments(), 0);
    assert.equal((await api("post", "/auth/login", null, { email: "unknown@example.com", password })).status, 500);
    await assertNoIntents();
  } finally { broken.mock.restore(); }
});

test("history survives disconnect and reconnect", async () => {
  await api("post", "/employees", "ADMIN", person);
  const event = await AuditEvent.findOne().lean();
  await mongoose.disconnect();
  await mongoose.connect(mongo.getUri());
  // A new MongoClient must initialize its own producer storage. Reject writes
  // before that point instead of silently reusing the disconnected client's Db.
  assert.equal((await api("post", "/employees", "ADMIN", { ...person, email: "uninitialized@example.com" })).status, 500);
  assert.equal(await Employee.exists({ email: "uninitialized@example.com" }), null);
  await Promise.all(["identity", "employees", "audit"].map((domain) => require(`../src/modules/${domain}`).initialize()));
  const history = await api("get", `/audit/${event._id}`);
  assert.equal(history.status, 200);
  assert.equal(history.body.data.resource.label, event.resource.label);
  assert.equal(history.body.data.action, "EMPLOYEE_CREATED");
  assert.equal((await api("patch", `/employees/${event.resource.id}`, "ADMIN", { department: "Platform" })).status, 200);
  await assertCaptured("employees", 2);
});

test("delivered and legacy history share the existing API without exposing delivery metadata", async () => {
  const employee = await Employee.create(person);
  // Seed actual pre-outbox history without delivery metadata, rather than using
  // an API write that now always captures an envelope and its matching identity.
  const legacy = (await AuditEvent.create({ action: "EMPLOYEE_CREATED", actor: null,
    resource: { type: "EMPLOYEE", id: employee._id, label: employee.employeeNumber },
    requestId: "legacy-request", occurredAt: new Date("2025-01-01T00:00:00.000Z"), changes: [] })).toObject();
  const receiver = createAuditConsumer(mongoose.connection.db);
  await receiver.initialize();
  const event = { ...prepareAuditEvent({
    action: "EMPLOYEE_UPDATED", requestId: "delivered-request",
    actor: { id: String(accounts.ADMIN._id), firstName: person.firstName, lastName: person.lastName, email: person.email, role: "ADMIN" },
    resource: { type: "EMPLOYEE", id: employee.id, label: employee.employeeNumber },
    changes: [{ field: "department", before: "Engineering", after: "Platform" }],
  }, { producer: "employees", occurredAt: "2026-01-01T00:00:00.000Z" }), sequence: 1 };
  const result = await receiver.consume(event, { producer: "employees" });
  const stored = await AuditEvent.collection.findOne({ _id: new mongoose.Types.ObjectId(result.auditId) });
  assert.ok(stored._delivery);
  const delivered = await api("get", `/audit/${result.auditId}`);
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.data.occurredAt, event.occurredAt);
  assert.equal(delivered.body.data._delivery, undefined);
  const history = await api("get", `/audit?resourceId=${employee.id}`);
  assert.equal(history.body.pagination.totalItems, 2);
  assert.ok(history.body.data.every((item) => item._delivery === undefined));
  assert.deepEqual((await api("get", `/audit/${legacy._id}`)).body.data, JSON.parse(JSON.stringify(legacy)));
});

test("outbox insertion failure rolls back employee create, update, delete, and sequence allocation", async () => {
  const employee = await Employee.create(person);
  await withBrokenOutbox("employee_audit_outbox", async () => {
    assert.equal((await api("post", "/employees", "ADMIN", { ...person, email: "outbox-rollback@example.com" })).status, 500);
    assert.equal(await Employee.exists({ email: "outbox-rollback@example.com" }), null);
    assert.equal((await api("patch", `/employees/${employee.id}`, "ADMIN", { department: "Changed", managerId: null })).status, 500);
    assert.equal((await Employee.findById(employee.id)).department, person.department);
    assert.equal((await api("delete", `/employees/${employee.id}`)).status, 500);
    assert.ok(await Employee.exists({ _id: employee.id }));
  });
  await assertNoIntents();
  assert.equal(await AuditEvent.countDocuments(), 0);
  assert.equal((await api("patch", `/employees/${employee.id}`, "ADMIN", { department: "Recovered" })).status, 200);
  const [intent] = await assertCaptured("employees", 1);
  assert.equal(intent.event.sequence, 1);
});

test("outbox insertion failure rolls back accounts and session rotation without sending cookies", async () => {
  const before = await Session.find().sort({ _id: 1 }).lean();
  await withBrokenOutbox("identity_audit_outbox", async () => {
    const requests = [
      ["/auth/register", null, { ...person, email: "outbox-account@example.com", password }],
      ["/auth/login", null, { email: accounts.ADMIN.email, password }],
      ["/auth/login", null, { email: "unknown@example.com", password }],
      ["/auth/refresh", "ADMIN"], ["/auth/logout", "ADMIN"],
    ];
    for (const [path, role, body] of requests) {
      const response = await api("post", path, role, body);
      assert.equal(response.status, 500, path);
      assert.equal(response.headers["set-cookie"], undefined, path);
    }
    assert.equal(await Account.exists({ email: "outbox-account@example.com" }), null);
    assert.deepEqual(await Session.find().sort({ _id: 1 }).lean(), before);
    assert.equal((await api("get", "/auth/me")).status, 200);
  });
  await assertNoIntents();
  assert.equal(await AuditEvent.countDocuments(), 0);
});

test("malformed, unknown-account, and incorrect-password logins capture only anonymous intents", async () => {
  for (const body of [
    { email: { attempted: "never-store-this-email" }, password },
    { email: "never-store-unknown@example.com", password },
    { email: accounts.ADMIN.email, password: "never-store-wrong-password" },
  ]) {
    const response = await api("post", "/auth/login", null, body);
    assert.equal(response.status, 401);
    assert.equal(response.headers["set-cookie"], undefined);
  }
  const intents = await assertCaptured("identity", 3);
  assert.equal(new Set(intents.map((intent) => intent.streamId)).size, 3);
  assert.ok(intents.every(({ event }) => event.action === "AUTH_LOGIN_FAILED" && event.actor === null &&
    event.resource.id === null && event.resource.label === "" && event.sequence === 1));
  assert.equal((await api("post", "/auth/refresh", null)).status, 401);
  assert.equal((await api("post", "/auth/logout", null)).status, 204);
  assert.equal(await AuditEvent.countDocuments(), 3);
});

test("transient transaction retries commit one intent and immediate record per employee operation", async () => {
  const insertOne = AuditEvent.collection.insertOne.bind(AuditEvent.collection);
  let failNext = true, attempts = 0;
  const retry = mock.method(AuditEvent.collection, "insertOne", async (...args) => {
    attempts++;
    if (failNext) {
      failNext = false;
      // Failure happens after sequence allocation and pending insertion, forcing
      // the driver's transaction retry to abort both before rebuilding the change.
      throw new mongoose.mongo.MongoServerError({ message: "Fixture transient conflict", code: 112, errorLabels: ["TransientTransactionError"] });
    }
    return insertOne(...args);
  });
  let employee;
  try {
    const created = await api("post", "/employees", "ADMIN", person);
    assert.equal(created.status, 201);
    employee = created.body.data;
    failNext = true;
    assert.equal((await api("patch", `/employees/${employee._id}`, "ADMIN", { managerId: null, department: "Retried" })).status, 200);
    assert.equal(attempts, 4);
  } finally { retry.mock.restore(); }
  assert.equal(await Employee.countDocuments(), 1);
  assert.equal((await Employee.findById(employee._id)).department, "Retried");
  const pending = await assertCaptured("employees", 2);
  assert.deepEqual(pending.map(({ event }) => event.sequence), [1, 2]);
  assert.equal(await AuditEvent.countDocuments(), 2);
});

test("a retried authentication transaction issues only the committed session's cookies and intent", async () => {
  const before = await Session.countDocuments();
  const insertOne = AuditEvent.collection.insertOne.bind(AuditEvent.collection);
  let attempts = 0;
  const retry = mock.method(AuditEvent.collection, "insertOne", async (...args) => {
    if (++attempts === 1)
      throw new mongoose.mongo.MongoServerError({ message: "Fixture transient conflict", code: 112, errorLabels: ["TransientTransactionError"] });
    return insertOne(...args);
  });
  try {
    const response = await api("post", "/auth/login", null, { email: accounts.ADMIN.email, password });
    assert.equal(response.status, 200);
    cookies.RETRIED = responseCookies(response);
    assert.equal((await api("get", "/auth/me", "RETRIED")).status, 200);
    assert.equal(attempts, 2);
  } finally { retry.mock.restore(); }
  assert.equal(await Session.countDocuments(), before + 1);
  const [intent] = await assertCaptured("identity", 1);
  assert.equal(intent.event.sequence, 1);
});

test("immediate envelope projection rejects missing, inactive, ended, and foreign transactions", async () => {
  const event = { ...prepareAuditEvent({ action: "AUTH_LOGIN_FAILED", actor: null,
    resource: { type: "ACCOUNT", id: null, label: "" }, requestId: "projection-test" }, { producer: "identity" }), sequence: 1 };
  await assert.rejects(appendEnvelope(event, { producer: "identity" }), /active transaction/);
  const session = await mongoose.startSession();
  try { await assert.rejects(appendEnvelope(event, { producer: "identity", session }), /active transaction/); }
  finally { await session.endSession(); }
  await assert.rejects(appendEnvelope(event, { producer: "identity", session }), /active transaction/);
  const foreign = await mongoose.createConnection(mongo.getUri()).asPromise();
  try {
    await foreign.transaction(async (foreignSession) => {
      await assert.rejects(appendEnvelope(event, { producer: "identity", session: foreignSession }), /audit database client/);
    });
  } finally { await foreign.close(); }
  await assert.rejects(mongoose.connection.transaction(async (activeSession) => {
    await assert.rejects(appendEnvelope(event, { producer: "employees", session: activeSession }), /trusted source/);
    await appendEnvelope(event, { producer: "identity", session: activeSession });
    throw new Error("Fixture abort after immediate history");
  }, { writeConcern: { w: "majority" } }), /Fixture abort after immediate history/);
  assert.equal(await AuditEvent.countDocuments(), 0);
});
