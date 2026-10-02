const { test } = require("node:test");
const assert = require("node:assert/strict");
const errorHandler = require("../src/middleware/errorHandler");

test("server failures hide internal messages, codes, and details", () => {
  let status, body;
  const res = { status(value) { status = value; return this; }, json(value) { body = value; } };
  errorHandler(Object.assign(new Error("database credentials"), { code: "SECRET_DATABASE_CODE", details: "private" }), {}, res, () => {});
  assert.equal(status, 500);
  assert.deepEqual(body, { error: { code: "INTERNAL_SERVER_ERROR", message: "Something went wrong. Please try again." } });
});
test("errors after headers are sent delegate to Express", () => {
  const error = new Error("stream failure");
  let forwarded;
  errorHandler(error, {}, { headersSent: true }, value => { forwarded = value; });
  assert.equal(forwarded, error);
});
