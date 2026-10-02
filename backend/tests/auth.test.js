process.env.JWT_ACCESS_SECRET = "test-only-secret-with-more-than-32-characters";
process.env.CLIENT_ORIGIN = "http://localhost:3000";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const app = require("../src/app");
const Account = require("../src/models/Account");
const Employee = require("../src/models/Employee");
const Session = require("../src/models/Session");
let mongo;
const origin = "http://localhost:3000";
const credentials = {
  firstName: "Jamie",
  lastName: "Morgan",
  email: "JAMIE@example.com",
  password: "a long secure passphrase",
};
const post = (path, body, cookies) => {
  const req = request(app)
    .post("/api/v1" + path)
    .set("Origin", origin);
  if (cookies) req.set("Cookie", cookies);
  return req.send(body || {});
};
const cookies = (response) =>
  response.headers["set-cookie"].map((value) => value.split(";")[0]);
before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Account.init();
  await Session.init();
});
after(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});
test("registration, role safety, refresh rotation, logout and protected directory", async () => {
  const response = await post("/auth/register", {
    ...credentials,
    role: "ADMIN",
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.role, "EMPLOYEE");
  assert.equal(response.body.data.email, "jamie@example.com");
  assert.equal(response.body.data.firstName, "Jamie");
  assert.equal(response.body.data.lastName, "Morgan");
  const stored = await Account.collection.findOne({ email: "jamie@example.com" });
  assert.equal(stored.firstName, "Jamie");
  assert.equal(stored.lastName, "Morgan");
  assert.equal(stored.firstname, undefined);
  assert.equal(stored.lastname, undefined);
  assert.equal(response.body.data.passwordHash, undefined);
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(await Session.countDocuments(), 0);
  assert.equal((await request(app).get("/api/v1/auth/me")).status, 401);
  assert.equal((await post("/auth/refresh")).status, 401);
  const login = await post("/auth/login", credentials);
  assert.equal(login.status, 200);
  assert.ok(
    login.headers["set-cookie"].every(
      (value) =>
        value.includes("HttpOnly") && value.includes("SameSite=Strict"),
    ),
  );
  const account = await Account.findOne({ email: "jamie@example.com" }).select(
    "+passwordHash",
  );
  assert.notEqual(account.passwordHash, credentials.password);
  const first = cookies(login);
  assert.equal(
    (await request(app).get("/api/v1/auth/me").set("Cookie", first)).status,
    200,
  );
  assert.equal((await request(app).get("/api/v1/employees")).status, 401);
  assert.equal((await post("/employees", credentials, first)).status, 403);
  assert.equal((await post("/auth/register", credentials)).status, 409);
  assert.equal(
    (
      await post("/auth/login", {
        email: credentials.email,
        password: "incorrect",
      })
    ).status,
    401,
  );
  const refreshed = await post("/auth/refresh", {}, first);
  assert.equal(refreshed.status, 200);
  assert.equal((await post("/auth/refresh", {}, first)).status, 401);
  assert.equal(
    (await request(app).get("/api/v1/auth/me").set("Cookie", first)).status,
    401,
  );
  const current = cookies(refreshed);
  assert.equal((await post("/auth/logout", {}, current)).status, 204);
  assert.equal(
    (await request(app).get("/api/v1/auth/me").set("Cookie", current)).status,
    401,
  );
  assert.equal((await post("/auth/refresh", {}, current)).status, 401);
  assert.equal((await post("/auth/login", credentials)).status, 200);
});
test("rejects CSRF, invalid inputs, and legacy public endpoints", async () => {
  assert.equal(
    (await request(app).post("/api/v1/auth/login").send(credentials)).status,
    403,
  );
  assert.equal(
    (
      await request(app)
        .post("/api/v1/auth/login")
        .set("Origin", "https://evil.example")
        .send(credentials)
    ).status,
    403,
  );
  assert.equal(
    (await post("/auth/register", { ...credentials, password: "short" }))
      .status,
    400,
  );
  assert.equal(
    (await post("/auth/register", { ...credentials, email: { $ne: null } }))
      .status,
    400,
  );
  assert.equal(
    (
      await post("/auth/register", {
        ...credentials,
        password: "🔐".repeat(20),
      })
    ).status,
    400,
  );
  assert.equal((await request(app).get("/auth/inventory")).status, 404);
});
test("employee CRUD enforces roles and limits employee visibility", async () => {
  await Account.updateOne({ email: "jamie@example.com" }, { role: "ADMIN" });
  const admin = cookies(await post("/auth/login", credentials));
  const created = await post("/employees", credentials, admin);
  assert.equal(created.status, 201);
  const id = created.body.data._id;
  assert.equal(
    (
      await request(app)
        .patch(`/api/v1/employees/${id}`)
        .set("Origin", origin)
        .set("Cookie", admin)
        .send({ ...credentials, firstName: "Updated" })
    ).status,
    200,
  );
  const otherCredentials = { ...credentials, email: "other@example.com" };
  await post("/auth/register", otherCredentials);
  const other = cookies(await post("/auth/login", otherCredentials));
  const directory = await request(app)
    .get("/api/v1/employees")
    .set("Cookie", other);
  assert.deepEqual(directory.body.data, []);
  assert.equal(
    (
      await request(app)
        .delete(`/api/v1/employees/${id}`)
        .set("Origin", origin)
        .set("Cookie", other)
    ).status,
    403,
  );
  assert.equal(
    (
      await request(app)
        .delete(`/api/v1/employees/${id}`)
        .set("Origin", origin)
        .set("Cookie", admin)
    ).status,
    204,
  );
});

test("legacy registration and stored accounts keep active sessions working through migration", async () => {
  const legacyCredentials = {
    firstname: " Legacy ", lastname: " Account ", email: "legacy-account@example.com", password: credentials.password,
  };
  const registered = await post("/auth/register", legacyCredentials);
  assert.equal(registered.status, 201);
  assert.equal(registered.body.data.firstName, "Legacy");
  assert.equal(registered.body.data.firstname, "Legacy");
  const id = new mongoose.Types.ObjectId(registered.body.data.id);
  await Account.collection.updateOne({ _id: id }, {
    $unset: { firstName: "", lastName: "" }, $set: { firstname: "Legacy", lastname: "Account" },
  });
  const beforeMigration = await Account.collection.findOne({ _id: id });
  const login = await post("/auth/login", legacyCredentials);
  assert.equal(login.status, 200);
  assert.equal(login.body.data.firstName, "Legacy");
  assert.equal(login.body.data.lastName, "Account");
  assert.equal(login.body.data.passwordHash, undefined);
  let current = cookies(login);
  const employeeId = new mongoose.Types.ObjectId();
  await Employee.collection.insertOne({
    _id: employeeId, firstname: "Legacy", lastname: "Account", email: legacyCredentials.email,
  });
  await request(app).get(`/api/v1/employees/${employeeId}`).set("Cookie", current).expect(200)
    .expect(res => assert.equal(res.body.data.firstName, "Legacy"));
  const { migrateNames } = require("../src/migrations/names");
  for (const options of [{ dryRun: false }, { dryRun: false, cleanup: true }]) {
    await migrateNames(mongoose.connection.db, options);
    const me = await request(app).get("/api/v1/auth/me").set("Cookie", current).expect(200);
    assert.equal(me.body.data.firstName, "Legacy");
    assert.equal(me.body.data.lastName, "Account");
    assert.equal(me.body.data.firstname, "Legacy");
    assert.equal(me.body.data.passwordHash, undefined);
    await request(app).get("/api/v1/employees?search=Legacy&sortBy=lastName")
      .set("Cookie", current).expect(200).expect(res => {
        assert.equal(res.body.data.length, 1);
        assert.equal(res.body.data[0]._id, String(employeeId));
        assert.equal(res.body.data[0].firstName, "Legacy");
        assert.equal(res.body.data[0].lastName, "Account");
      });
    await request(app).get(`/api/v1/employees/${employeeId}`).set("Cookie", current).expect(200)
      .expect(res => assert.equal(res.body.data.lastName, "Account"));
    const refresh = await post("/auth/refresh", {}, current);
    assert.equal(refresh.status, 200);
    assert.equal(refresh.body.data.firstName, "Legacy");
    assert.equal(refresh.body.data.lastName, "Account");
    current = cookies(refresh);
  }
  const afterMigration = await Account.collection.findOne({ _id: id });
  const { firstname, lastname, ...unchanged } = beforeMigration;
  assert.deepEqual(afterMigration, { ...unchanged, firstName: "Legacy", lastName: "Account" });
  assert.equal((await post("/auth/logout", {}, current)).status, 204);
});

test("auth rejects conflicting name spellings without creating an account", async () => {
  const response = await post("/auth/register", {
    ...credentials, email: "conflict@example.com", firstname: "Someone else",
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "VALIDATION_ERROR");
  assert.equal(await Account.countDocuments({ email: "conflict@example.com" }), 0);
});
