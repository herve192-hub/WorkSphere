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
const profile = { firstname: "Jamie", lastname: "Morgan", email: "jamie@example.com" };
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
beforeEach(async () => { await Employee.deleteMany({}); });
after(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });

test("CRUD, normalization, conflicts, partial updates, and missing resources", async () => {
  const created = await api("post", "", "ADMIN", { ...profile, email: " JAMIE@EXAMPLE.COM " }).expect(201);
  const id = created.body.data._id;
  assert.equal(created.body.data.email, profile.email);
  await api("post", "", "ADMIN", profile).expect(409).expect(res => assert.equal(res.body.error.code, "DUPLICATE_RESOURCE"));
  await api("get", "/" + id).expect(200);
  await api("patch", "/" + id, "ADMIN", { department: "Platform" }).expect(200)
    .expect(res => { assert.equal(res.body.data.firstname, "Jamie"); assert.equal(res.body.data.department, "Platform"); });
  await api("patch", "/" + id, "ADMIN", { firstname: " " }).expect(400);
  assert.equal((await Employee.findById(id)).firstname, "Jamie");
  await api("delete", "/" + id).expect(204).expect(res => assert.equal(res.text, ""));
  for (const method of ["get", "patch", "delete"]) {
    await api(method, "/" + id, "ADMIN", method === "patch" ? { firstname: "New" } : undefined).expect(404);
    await api(method, "/bad-id", "ADMIN", method === "patch" ? { firstname: "New" } : undefined).expect(400);
  }
});

test("pagination has stable ties, literal search, combined filters, and strict queries", async () => {
  await Employee.create([
    { ...profile, email: "a@example.com", department: "Engineering", jobTitle: "C++" },
    { ...profile, email: "b@example.com", department: "Engineering", employmentStatus: "INACTIVE" },
    { ...profile, email: "c@example.com", department: "Sales" },
  ]);
  const first = await api("get", "?sortBy=lastname&sortOrder=asc&limit=1").expect(200);
  const second = await api("get", "?sortBy=lastname&sortOrder=asc&limit=1&page=2").expect(200);
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
  await api("patch", "/" + own._id, "EMPLOYEE", { firstname: "Changed" }).expect(403);
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
