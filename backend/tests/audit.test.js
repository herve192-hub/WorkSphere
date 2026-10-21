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
const { createAuditConsumer } = require("../src/modules/audit");
const { prepareAuditEvent } = require("../src/contracts/auditEvent");
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
before(async () => {
  await loadContract();
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all([Account.init(), Employee.init(), Session.init(), AuditEvent.init()]);
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
});
after(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });

test("CRUD history retains actor, request, changed fields, and deleted resource without credentials", async () => {
  const created = await api("post", "/employees", "HR_MANAGER", {
    ...person, password: "never-store-this-password", passwordHash: "never-store-this-hash",
    actor: { role: "ADMIN" }, token: "never-store-this-token",
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
  await api("post", "/employees", "ADMIN", person);
  assert.equal((await api("post", "/employees", "ADMIN", person)).status, 409);
  assert.equal(await AuditEvent.countDocuments(), 1);
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
  } finally { broken.mock.restore(); }
});

test("history survives disconnect and reconnect", async () => {
  await api("post", "/employees", "ADMIN", person);
  const event = await AuditEvent.findOne().lean();
  await mongoose.disconnect();
  await mongoose.connect(mongo.getUri());
  const history = await api("get", `/audit/${event._id}`);
  assert.equal(history.status, 200);
  assert.equal(history.body.data.resource.label, event.resource.label);
  assert.equal(history.body.data.action, "EMPLOYEE_CREATED");
});

test("delivered and legacy history share the existing API without exposing delivery metadata", async () => {
  const created = await api("post", "/employees", "ADMIN", person);
  const legacy = await AuditEvent.findOne().lean();
  const receiver = createAuditConsumer(mongoose.connection.db);
  await receiver.initialize();
  const event = { ...prepareAuditEvent({
    action: "EMPLOYEE_UPDATED", requestId: "delivered-request",
    actor: { id: String(accounts.ADMIN._id), firstName: person.firstName, lastName: person.lastName, email: person.email, role: "ADMIN" },
    resource: { type: "EMPLOYEE", id: created.body.data._id, label: created.body.data.employeeNumber },
    changes: [{ field: "department", before: "Engineering", after: "Platform" }],
  }, { producer: "employees", occurredAt: "2026-01-01T00:00:00.000Z" }), sequence: 1 };
  const result = await receiver.consume(event, { producer: "employees" });
  const stored = await AuditEvent.collection.findOne({ _id: new mongoose.Types.ObjectId(result.auditId) });
  assert.ok(stored._delivery);
  const delivered = await api("get", `/audit/${result.auditId}`);
  assert.equal(delivered.status, 200);
  assert.equal(delivered.body.data.occurredAt, event.occurredAt);
  assert.equal(delivered.body.data._delivery, undefined);
  const history = await api("get", `/audit?resourceId=${created.body.data._id}`);
  assert.equal(history.body.pagination.totalItems, 2);
  assert.ok(history.body.data.every((item) => item._delivery === undefined));
  assert.deepEqual((await api("get", `/audit/${legacy._id}`)).body.data, JSON.parse(JSON.stringify(legacy)));
});
