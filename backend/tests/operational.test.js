process.env.JWT_ACCESS_SECRET = "test-only-secret-with-more-than-32-characters";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const app = require("../src/app");

test("liveness is available without a database connection", async () => {
  const response = await request(app).get("/health/live").expect(200);
  assert.equal(response.body.status, "UP");
  assert.equal(response.body.service, "worksphere-api");
  assert.ok(response.headers["x-request-id"]);
});

test("readiness reports unavailable while MongoDB is disconnected", async () => {
  const response = await request(app).get("/health/ready").expect(503);
  assert.deepEqual(response.body.dependencies, { mongodb: "DOWN" });
});

test("accepts a safe caller request ID and replaces unsafe IDs", async () => {
  const supplied = await request(app).get("/health/live").set("X-Request-Id", "client-request-123").expect(200);
  assert.equal(supplied.headers["x-request-id"], "client-request-123");

  const replaced = await request(app).get("/health/live").set("X-Request-Id", "unsafe request id").expect(200);
  assert.notEqual(replaced.headers["x-request-id"], "unsafe request id");
  assert.match(replaced.headers["x-request-id"], /^[0-9a-f-]{36}$/i);
});
