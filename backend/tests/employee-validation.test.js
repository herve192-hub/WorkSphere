process.env.JWT_ACCESS_SECRET = "test-only-secret-with-more-than-32-characters";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { employeePayload } = require("../src/services/employeeValidation");

test("normalizes an employee payload and accepts refined domain fields", () => {
  const data = employeePayload({
    firstName: "  Jamie ",
    lastName: " Morgan ",
    email: "JAMIE@EXAMPLE.COM",
    jobTitle: "Software Engineer",
    department: "Engineering",
    employmentStatus: "ACTIVE",
    location: "Chicago",
  });
  assert.equal(data.firstName, "Jamie");
  assert.equal(data.lastName, "Morgan");
  assert.equal(data.email, "jamie@example.com");
  assert.equal(data.employeeNumber, undefined);
  assert.equal(data.department, "Engineering");
});

test("employee numbers are backend-owned on both create and patch", () => {
  for (const employeeNumber of ["EMP-000001", "", null, 123, {}, undefined]) {
    for (const partial of [false, true]) {
      assert.throws(() => employeePayload({
        firstName: "Jamie", lastName: "Morgan", email: "jamie@example.com", employeeNumber,
      }, { partial }), { status: 400, code: "VALIDATION_ERROR" });
    }
  }
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
    null, [], "invalid", { firstName: "" }, { lastName: " " },
    { email: { $ne: null } }, { managerId: "bad" }, { managerId: {} },
    { hireDate: true }, { hireDate: 123 }, { hireDate: "2025-02-29" },
    { hireDate: "2024-04-31" }, { avatarUrl: "javascript:alert(1)" },
    { avatarUrl: "https://user:password@example.com" },
    { employeeNumber: " " }, { department: "a".repeat(121) },
    { firstName: "a".repeat(81) },
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

const { profile } = require("../src/services/validation");
test("auth and employee writes normalize legacy and mixed name spellings", () => {
  for (const validate of [profile, employeePayload]) {
    for (const names of [
      { firstname: " Jamie ", lastname: " Morgan " },
      { firstName: " Jamie ", lastname: " Morgan " },
      { firstname: " Jamie ", lastName: " Morgan " },
      { firstName: "Jamie", firstname: " Jamie ", lastName: "Morgan", lastname: "Morgan" },
    ]) {
      assert.deepEqual(validate({ ...names, email: "JAMIE@EXAMPLE.COM" }), {
        firstName: "Jamie", lastName: "Morgan", email: "jamie@example.com",
      });
    }
  }
  assert.deepEqual(employeePayload({ firstname: " Renamed " }, { partial: true }), { firstName: "Renamed" });
});

test("conflicting or invalid name aliases cannot bypass validation", () => {
  for (const validate of [profile, employeePayload]) {
    for (const extra of [
      { firstname: "Different" }, { lastname: "Different" },
      { firstname: null }, { lastname: { $ne: null } },
      { firstName: "", firstname: "Jamie" }, { lastName: null, lastname: "Morgan" },
      { firstName: "a".repeat(81) },
    ]) assert.throws(() => validate({ firstName: "Jamie", lastName: "Morgan", email: "j@example.com", ...extra }), { status: 400 });
  }
  for (const names of [{ firstname: "" }, { lastname: " " }, { firstname: "a".repeat(81) }, { lastname: [] }])
    assert.throws(() => employeePayload(names, { partial: true }), { status: 400 });
  assert.throws(() => employeePayload({ firstName: "One", firstname: "Two" }, { partial: true }), { status: 400 });
});

test("name sort aliases map to the canonical fields", () => {
  for (const [canonical, legacy] of [["firstName", "firstname"], ["lastName", "lastname"]]) {
    assert.equal(employeeQuery({ sortBy: canonical }).sortBy, canonical);
    assert.equal(employeeQuery({ sortBy: legacy }).sortBy, canonical);
  }
});
