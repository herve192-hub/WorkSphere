process.env.JWT_ACCESS_SECRET = "test-only-secret-with-more-than-32-characters";
process.env.CLIENT_ORIGIN = "http://localhost:3000";
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const app = require("../src/app");
const Account = require("../src/models/Account");
const Employee = require("../src/models/Employee");
const origin = "http://localhost:3000";
const base = "/api/v1/employees";
let mongo;
const sessions = {};
const profile = { firstName: "Jamie", lastName: "Morgan", email: "jamie@example.com" };
function api(method, path = "", role = "ADMIN", body) {
  const req = request(app)[method](base + path).set("Origin", origin);
  if (role) req.set("Cookie", sessions[role]);
  return body === undefined ? req : req.send(body);
}
before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([Account.init(), Employee.init()]);
  for (const role of ["ADMIN", "HR_MANAGER", "EMPLOYEE"]) {
    const credentials = { ...profile, email: role.toLowerCase() + "@example.com", password: "a long secure passphrase" };
    await request(app).post("/api/v1/auth/register").set("Origin", origin).send(credentials).expect(201);
    await Account.updateOne({ email: credentials.email }, { role });
    const login = await request(app).post("/api/v1/auth/login").set("Origin", origin).send(credentials).expect(200);
    sessions[role] = login.headers["set-cookie"].map(value => value.split(";")[0]);
  }
});
beforeEach(async () => {
  await Employee.deleteMany({});
  await mongoose.connection.db.collection("counters").deleteMany({});
});
after(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });

test("CRUD, normalization, conflicts, partial updates, and missing resources", async () => {
  const created = await api("post", "", "ADMIN", { ...profile, email: " JAMIE@EXAMPLE.COM " }).expect(201);
  const id = created.body.data._id;
  assert.equal(created.body.data.email, profile.email);
  assert.equal(created.body.data.firstName, "Jamie");
  assert.equal(created.body.data.lastName, "Morgan");
  assert.equal(created.body.data.employeeNumber, "EMP-000001");
  const stored = await Employee.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
  assert.equal(stored.firstName, "Jamie");
  assert.equal(stored.lastName, "Morgan");
  assert.equal(stored.firstname, undefined);
  assert.equal(stored.lastname, undefined);
  assert.equal(stored.employeeNumber, "EMP-000001");
  await api("post", "", "ADMIN", profile).expect(409).expect(res => assert.equal(res.body.error.code, "DUPLICATE_RESOURCE"));
  await api("get", "/" + id).expect(200);
  await api("patch", "/" + id, "ADMIN", { department: "Platform" }).expect(200)
    .expect(res => { assert.equal(res.body.data.firstName, "Jamie"); assert.equal(res.body.data.department, "Platform"); });
  await api("patch", "/" + id, "ADMIN", { firstName: " " }).expect(400);
  assert.equal((await Employee.findById(id)).firstName, "Jamie");
  await api("delete", "/" + id).expect(204).expect(res => assert.equal(res.text, ""));
  for (const method of ["get", "patch", "delete"]) {
    await api(method, "/" + id, "ADMIN", method === "patch" ? { firstName: "New" } : undefined).expect(404);
    await api(method, "/bad-id", "ADMIN", method === "patch" ? { firstName: "New" } : undefined).expect(400);
  }
});

test("concurrent API creates allocate unique sequential employee numbers", async () => {
  const responses = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    api("post", "", i % 2 ? "HR_MANAGER" : "ADMIN", { ...profile, email: `concurrent-${i}@example.com` }).expect(201),
  ));
  const numbers = responses.map(res => res.body.data.employeeNumber).sort();
  assert.deepEqual(numbers, Array.from({ length: 20 }, (_, i) => `EMP-${String(i + 1).padStart(6, "0")}`));
  await api("get", `?search=${numbers[0]}`).expect(200)
    .expect(res => assert.equal(res.body.data[0].employeeNumber, numbers[0]));
  await api("get", "?sortBy=employeeNumber&sortOrder=asc").expect(200)
    .expect(res => assert.deepEqual(res.body.data.map(employee => employee.employeeNumber), numbers));
});

test("clients cannot supply, overwrite, or clear an employee number", async () => {
  for (const employeeNumber of ["EMP-999999", "", null, { $ne: null }]) {
    await api("post", "", "ADMIN", { ...profile, employeeNumber }).expect(400)
      .expect(res => assert.equal(res.body.error.code, "VALIDATION_ERROR"));
  }
  const created = await api("post", "", "HR_MANAGER", profile).expect(201);
  const { _id: id, employeeNumber: number } = created.body.data;
  for (const role of ["ADMIN", "HR_MANAGER"]) {
    for (const employeeNumber of [number, "EMP-999999", "", null]) {
      await api("patch", "/" + id, role, { employeeNumber, department: "Changed" }).expect(400);
    }
  }
  await api("patch", "/" + id, "ADMIN", { department: "Platform", email: "new@example.com" }).expect(200)
    .expect(res => assert.equal(res.body.data.employeeNumber, number));
  const stored = await Employee.findById(id);
  assert.equal(stored.employeeNumber, number);
  assert.equal(stored.department, "Platform");
});

test("model creation generates numbers and model updates preserve them", async () => {
  const employee = await Employee.create({ ...profile, employeeNumber: "CLIENT-SUPPLIED" });
  assert.equal(employee.employeeNumber, "EMP-000001");
  employee.employeeNumber = "EMP-999999";
  employee.department = "Platform";
  await employee.save();
  assert.equal(employee.employeeNumber, "EMP-000001");
  await Employee.updateOne({ _id: employee._id }, { $set: { employeeNumber: "EMP-999999", phone: "123" } });
  await Employee.updateOne({ _id: employee._id }, { $unset: { employeeNumber: "" } });
  assert.equal((await Employee.findById(employee._id)).employeeNumber, "EMP-000001");
  await assert.rejects(Employee.collection.insertOne({
    ...profile, email: "duplicate-number@example.com", employeeNumber: employee.employeeNumber,
  }), { code: 11000 });
});

test("deletions and failed creates do not reuse allocated numbers", async () => {
  const first = await api("post", "", "ADMIN", profile).expect(201);
  await api("post", "", "ADMIN", profile).expect(409);
  await api("delete", "/" + first.body.data._id).expect(204);
  const next = await api("post", "", "ADMIN", profile).expect(201);
  assert.equal(next.body.data.employeeNumber, "EMP-000003");
});

test("initialization preserves legacy numbers and grows past six digits", async () => {
  const existing = await Employee.collection.insertOne({ ...profile, employeeNumber: "EMP-999999" });
  await Employee.collection.insertOne({ ...profile, email: "custom@example.com", employeeNumber: "WS-100" });
  const created = await api("post", "", "ADMIN", { ...profile, email: "new@example.com" }).expect(201);
  assert.equal(created.body.data.employeeNumber, "EMP-1000000");
  await api("patch", "/" + existing.insertedId, "ADMIN", { jobTitle: "Engineer" }).expect(200)
    .expect(res => assert.equal(res.body.data.employeeNumber, "EMP-999999"));
});

test("pagination has stable ties, literal search, combined filters, and strict queries", async () => {
  await Employee.create([
    { ...profile, email: "a@example.com", department: "Engineering", jobTitle: "C++" },
    { ...profile, email: "b@example.com", department: "Engineering", employmentStatus: "INACTIVE" },
    { ...profile, email: "c@example.com", department: "Sales" },
  ]);
  const first = await api("get", "?sortBy=lastName&sortOrder=asc&limit=1").expect(200);
  const second = await api("get", "?sortBy=lastName&sortOrder=asc&limit=1&page=2").expect(200);
  assert.notEqual(first.body.data[0]._id, second.body.data[0]._id);
  assert.deepEqual(first.body.pagination, { page: 1, limit: 1, totalItems: 3, totalPages: 3 });
  await api("get", "?department=Engineering&status=active&search=C%2B%2B").expect(200)
    .expect(res => assert.equal(res.body.pagination.totalItems, 1));
  await api("get", "?search=.*").expect(200).expect(res => assert.equal(res.body.data.length, 0));
  await api("get", "?page=99").expect(200).expect(res => assert.deepEqual(res.body.data, []));
  for (const query of ["page=1abc", "limit=101", "search=a&search=b", "sortBy=bad", "status=bad"])
    await api("get", "?" + query).expect(400);
});

test("role matrix and employee visibility hold across all endpoints", async () => {
  const own = await Employee.create({ ...profile, email: "employee@example.com" });
  const other = await Employee.create(profile);
  await api("get", "", null).expect(401);
  await api("get", "", "EMPLOYEE").expect(200).expect(res => assert.deepEqual(res.body.data.map(e => e._id), [String(own._id)]));
  await api("get", "/" + own._id, "EMPLOYEE").expect(200);
  await api("get", "/" + other._id, "EMPLOYEE").expect(403);
  await api("post", "", "EMPLOYEE", profile).expect(403);
  await api("patch", "/" + own._id, "EMPLOYEE", { firstName: "Changed" }).expect(403);
  await api("delete", "/" + own._id, "EMPLOYEE").expect(403);
  const hrCreated = await api("post", "", "HR_MANAGER", { ...profile, email: "hr-created@example.com" }).expect(201);
  await api("patch", "/" + hrCreated.body.data._id, "HR_MANAGER", { department: "HR" }).expect(200);
  await api("delete", "/" + hrCreated.body.data._id, "HR_MANAGER").expect(403);
  await api("get", "", "HR_MANAGER").expect(200).expect(res => assert.equal(res.body.data.length, 3));
});

test("invalid fields and parser failures produce structured client errors", async () => {
  for (const extra of [{ managerId: "bad" }, { hireDate: "2025-02-29" }, { employmentStatus: "bad" }, { email: { $ne: null } }])
    await api("post", "", "ADMIN", { ...profile, ...extra }).expect(400)
      .expect(res => assert.equal(res.body.error.code, "VALIDATION_ERROR"));
  await api("post").set("Content-Type", "application/json").send('{"broken":').expect(400)
    .expect(res => assert.equal(res.body.error.code, "INVALID_JSON"));
  await api("post", "", "ADMIN", { ...profile, phone: "a".repeat(17000) }).expect(413)
    .expect(res => assert.equal(res.body.error.code, "PAYLOAD_TOO_LARGE"));
});

test("legacy clients can create and patch employees while storage stays canonical", async () => {
  const created = await api("post", "", "ADMIN", {
    firstname: " Legacy ", lastname: " Client ", email: "legacy-client@example.com",
  }).expect(201);
  const id = created.body.data._id;
  assert.equal(created.body.data.firstName, "Legacy");
  assert.equal(created.body.data.firstname, "Legacy");
  assert.equal(created.body.data.lastName, "Client");
  assert.equal(created.body.data.lastname, "Client");
  await api("patch", "/" + id, "ADMIN", { firstname: "Updated", lastName: "Mixed" }).expect(200)
    .expect(res => {
      assert.equal(res.body.data.firstName, "Updated");
      assert.equal(res.body.data.firstname, "Updated");
      assert.equal(res.body.data.lastName, "Mixed");
    });
  await api("patch", "/" + id, "ADMIN", { firstName: "One", firstname: "Two" }).expect(400);
  const stored = await Employee.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
  assert.equal(stored.firstName, "Updated");
  assert.equal(stored.firstname, undefined);
  assert.equal(stored.lastname, undefined);
});

test("legacy stored employees can be read and patched before backfill", async () => {
  const id = new mongoose.Types.ObjectId();
  await Employee.collection.insertOne({
    _id: id, firstname: "Legacy", lastname: "Person", email: "stored@example.com", department: "Old",
  });
  await api("get", "/" + id).expect(200).expect(res => {
    assert.equal(res.body.data.firstName, "Legacy");
    assert.equal(res.body.data.lastName, "Person");
  });
  await api("patch", "/" + id, "ADMIN", { department: "New" }).expect(200).expect(res => {
    assert.equal(res.body.data.firstName, "Legacy");
    assert.equal(res.body.data.lastName, "Person");
  });
  await api("patch", "/" + id, "ADMIN", { firstName: "Canonical" }).expect(200).expect(res => {
    assert.equal(res.body.data.firstname, "Canonical");
    assert.equal(res.body.data.lastName, "Person");
  });
  const stored = await Employee.collection.findOne({ _id: id });
  assert.equal(stored.firstName, "Canonical");
  assert.equal(stored.firstname, undefined);
  assert.equal(stored.lastname, "Person");
  await api("patch", "/" + id, "ADMIN", { lastname: "Updated" }).expect(200);
  assert.equal((await Employee.collection.findOne({ _id: id })).lastname, undefined);
});

test("name search, sorting and pagination resolve mixed records with canonical precedence", async () => {
  const records = [
    { firstName: "Ben", lastName: "Middle", firstname: "Stale", lastname: "Discarded", email: "b@example.com" },
    { firstname: "Amy", lastname: "Zulu", email: "a@example.com" },
    { firstName: "Cara", lastname: "Alpha", email: "c@example.com" },
    { firstName: null, firstname: "Dan", lastName: null, lastname: "Middle", email: "d@example.com" },
  ].map((record, i) => ({ ...record, _id: new mongoose.Types.ObjectId(String(i + 1).padStart(24, "0")), employmentStatus: "ACTIVE", department: "Engineering" }));
  await Employee.collection.insertMany(records);
  for (const [field, expected] of [
    ["firstName", ["Amy", "Ben", "Cara", "Dan"]],
    ["firstname", ["Amy", "Ben", "Cara", "Dan"]],
    ["lastName", ["Cara", "Ben", "Dan", "Amy"]],
    ["lastname", ["Cara", "Ben", "Dan", "Amy"]],
  ]) {
    const found = [];
    for (let page = 1; page <= 2; page++) {
      const response = await api("get", `?sortBy=${field}&sortOrder=asc&limit=2&page=${page}`).expect(200);
      assert.equal(response.body.pagination.totalItems, 4);
      found.push(...response.body.data.map(record => record.firstName));
    }
    assert.deepEqual(found, expected);
    await api("get", `?sortBy=${field}&sortOrder=desc`).expect(200)
      .expect(res => assert.deepEqual(res.body.data.map(record => record.firstName), [...expected].reverse()));
  }
  for (const [search, expected] of [["Amy", 1], ["Alpha", 1], ["Middle", 2], ["Dan", 1], ["Stale", 0], ["Discarded", 0]])
    await api("get", `?search=${search}&department=Engineering&status=active`).expect(200)
      .expect(res => assert.equal(res.body.pagination.totalItems, expected));
});

test("models save canonical names and can validate previously stored legacy records", async () => {
  const created = await Employee.create({ firstname: "Model", lastname: "Compat", email: "model@example.com" });
  let stored = await Employee.collection.findOne({ _id: created._id });
  assert.equal(stored.firstName, "Model");
  assert.equal(stored.firstname, undefined);
  await Employee.collection.updateOne({ _id: created._id }, {
    $unset: { firstName: "", lastName: "" }, $set: { firstname: "Old", lastname: "Record" },
  });
  const legacy = await Employee.findById(created._id);
  legacy.department = "Saved";
  await legacy.save();
  stored = await Employee.collection.findOne({ _id: created._id });
  assert.equal(stored.firstName, "Old");
  assert.equal(stored.lastName, "Record");
  assert.equal(stored.firstname, undefined);
  assert.equal(stored.lastname, undefined);
  await assert.rejects(Employee.create({ firstName: "", lastName: "Valid", email: "invalid@example.com" }), { name: "ValidationError" });
});
