process.env.JWT_ACCESS_SECRET = "test-only-secret-with-more-than-32-characters";
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const app = require("../src/app");
const document = require("../src/docs/openapi");
const { loadContract, assertResponse } = require("./helpers/contract");
before(loadContract);

test("public OpenAPI and locally served Swagger assets work with the security policy", async () => {
  const spec = await request(app).get("/openapi.json").expect(200).expect("Content-Type", /json/);
  assert.deepEqual(spec.body, document);
  const ids = Object.values(document.paths).flatMap((path) => Object.values(path).map((operation) => operation.operationId));
  assert.equal(new Set(ids).size, ids.length);
  await request(app).get("/docs").expect(302).expect("Location", "/docs/");
  const html = await request(app).get("/docs/").expect(200).expect("Content-Type", /html/);
  assert.match(html.text, /WorkSphere API documentation/);
  assert.match(html.headers["content-security-policy"], /script-src 'self'/);
  assert.doesNotMatch(html.headers["content-security-policy"], /upgrade-insecure-requests/);
  assert.doesNotMatch(html.text, /https?:\/\//); // Swagger assets stay local.
  for (const asset of ["assets/swagger-ui.css", "assets/swagger-ui-bundle.js", "assets/swagger-ui-standalone-preset.js", "initializer.js"])
    await request(app).get(`/docs/${asset}`).expect(200);
});
test("health and unauthenticated responses match their documented schemas", async () => {
  for (const path of ["/health", "/health/live", "/health/ready", "/api/v1/auth/me", "/api/v1/employees", "/api/v1/audit"])
    assertResponse(await request(app).get(path), path, "get");
});
