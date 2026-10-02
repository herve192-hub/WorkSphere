process.env.JWT_ACCESS_SECRET = "test-only-secret-with-more-than-32-characters";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { employeePayload } = require("../src/services/employeeValidation");

test("normalizes an employee payload and accepts refined domain fields", () => {
  const data = employeePayload({
    firstname: "  Jamie ",
    lastname: " Morgan ",
    email: "JAMIE@EXAMPLE.COM",
    employeeNumber: " EMP-1001 ",
    jobTitle: "Software Engineer",
    department: "Engineering",
    employmentStatus: "ACTIVE",
    location: "Chicago",
  });
  assert.equal(data.firstname, "Jamie");
  assert.equal(data.lastname, "Morgan");
  assert.equal(data.email, "jamie@example.com");
  assert.equal(data.employeeNumber, "EMP-1001");
  assert.equal(data.department, "Engineering");
});

test("patch payloads may update one field without requiring profile fields", () => {
  assert.deepEqual(employeePayload({ department: "Platform" }, { partial: true }), {
    department: "Platform",
  });
});

test("rejects invalid employee status and empty patches", () => {
  assert.throws(
    () => employeePayload({ employmentStatus: "UNKNOWN" }, { partial: true }),
    /Employment status is invalid/,
  );
  assert.throws(() => employeePayload({}, { partial: true }), /at least one employee field/);
});

const { employeeQuery } = require("../src/services/employeeValidation");
test("rejects malformed and unsafe employee fields on PATCH", () => {
  for (const body of [
    null, [], "invalid", { firstname: "" }, { lastname: " " },
    { email: { $ne: null } }, { managerId: "bad" }, { managerId: {} },
    { hireDate: true }, { hireDate: 123 }, { hireDate: "2025-02-29" },
    { hireDate: "2024-04-31" }, { avatarUrl: "javascript:alert(1)" },
    { avatarUrl: "https://user:password@example.com" },
    { employeeNumber: " " }, { department: "a".repeat(121) },
    { firstname: "a".repeat(81) },
  ]) {
    assert.throws(() => employeePayload(body, { partial: true }),
      { status: 400, code: "VALIDATION_ERROR" }, JSON.stringify(body));
  }
});
test("accepts explicit nullable fields and real leap dates; ignores protected fields", () => {
  const data = employeePayload({
    hireDate: "2024-02-29", managerId: null, avatarUrl: "",
    role: "ADMIN", _id: "fake", createdAt: "fake",
  }, { partial: true });
  assert.deepEqual(data, { hireDate: new Date("2024-02-29"), managerId: null, avatarUrl: "" });
  assert.deepEqual(employeePayload({ hireDate: "" }, { partial: true }), { hireDate: null });
});
test("query defaults and normalization are explicit", () => {
  assert.deepEqual(employeeQuery(), { page: 1, limit: 20, sortBy: "createdAt", sortOrder: "desc" });
  assert.equal(employeeQuery({ status: "active", limit: "100" }).status, "ACTIVE");
});
test("rejects ambiguous, unbounded, and injected query parameters", () => {
  for (const query of [
    { page: "0" }, { page: "-1" }, { page: "1.2" }, { page: "1abc" },
    { limit: "101" }, { limit: "" }, { page: "9007199254740992" },
    { page: "9007199254740991", limit: "100" },
    { sortBy: "password" }, { sortOrder: "up" }, { status: "unknown" },
    { search: ["a", "b"] }, { department: { $ne: null } },
    { search: "a".repeat(255) }, { unexpected: "x" },
  ]) assert.throws(() => employeeQuery(query), { status: 400, code: "VALIDATION_ERROR" });
});
