process.env.JWT_ACCESS_SECRET = "test-only-secret-with-more-than-32-characters";
process.env.CLIENT_ORIGIN = "http://localhost:3000";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const app = require("../src/app");
const Account = require("../src/models/Account");
const Session = require("../src/models/Session");
let mongo;
const origin = "http://localhost:3000";
const credentials = {
  firstname: "Jamie",
  lastname: "Morgan",
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
        .send({ ...credentials, firstname: "Updated" })
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
