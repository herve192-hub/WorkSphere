const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { nextEmployeeNumber } = require("../src/services/employeeNumbers");
const { migrateEmployeeNumbers } = require("../src/migrations/employeeNumbers");
const run = promisify(execFile);
let mongo;
let db;

before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  db = mongoose.connection.db;
});
beforeEach(async () => { await db.dropDatabase(); });
after(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });

async function seed() {
  await db.collection("users").insertMany([
    { employeeNumber: "EMP-000010" },
    { employeeNumber: "WS-100" },
    {}, { employeeNumber: null }, { employeeNumber: "" }, { employeeNumber: "  " },
  ].map((employee, i) => ({
    ...employee, firstName: "Jamie", lastName: "Morgan", email: `legacy-${i}@example.com`,
    department: "Engineering", createdAt: new Date("2020-01-01"), updatedAt: new Date("2021-01-01"),
  })));
}

async function snapshot() {
  return {
    employees: await db.collection("users").find().sort({ _id: 1 }).toArray(),
    counters: await db.collection("counters").find().toArray(),
    indexes: await db.collection("users").listIndexes().toArray(),
  };
}

test("dry-run audits missing numbers without changing employees, counters, or indexes", async () => {
  await seed();
  const before = await snapshot();
  const report = await migrateEmployeeNumbers(db);
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.before, { documents: 6, missingNumbers: 4, invalidNumbers: 0, duplicateNumbers: 0 });
  assert.deepEqual(await snapshot(), before);
});

test("backfill preserves existing numbers and metadata, creates a unique index, and is repeatable", async () => {
  await seed();
  const before = await snapshot();
  const report = await migrateEmployeeNumbers(db, { dryRun: false, batchSize: 2 });
  assert.equal(report.modifiedDocuments, 4);
  assert.equal(report.after.missingNumbers, 0);
  const after = await snapshot();
  assert.deepEqual(after.employees.map(employee => employee.employeeNumber), [
    "EMP-000010", "WS-100", "EMP-000011", "EMP-000012", "EMP-000013", "EMP-000014",
  ]);
  for (let i = 0; i < after.employees.length; i++) {
    const { employeeNumber: oldNumber, ...oldFields } = before.employees[i];
    const { employeeNumber: newNumber, ...newFields } = after.employees[i];
    assert.deepEqual(newFields, oldFields);
  }
  assert.ok(after.indexes.some(index => index.name === "employeeNumber_1" && index.unique));
  assert.equal((await migrateEmployeeNumbers(db, { dryRun: false })).modifiedDocuments, 0);
  assert.deepEqual(await snapshot(), after);
  assert.equal(await nextEmployeeNumber(db), "EMP-000015");
});

test("invalid or duplicate existing numbers block writes before counter initialization", async () => {
  for (const employeeNumbers of [["WS-100", "WS-100"], [42], ["a".repeat(41)]]) {
    await db.dropDatabase();
    await db.collection("users").insertMany(employeeNumbers.map(employeeNumber => ({ employeeNumber })));
    const before = await snapshot();
    const report = await migrateEmployeeNumbers(db);
    assert.ok(report.before.invalidNumbers || report.before.duplicateNumbers);
    await assert.rejects(migrateEmployeeNumbers(db, { dryRun: false }), /invalid or duplicate/);
    assert.deepEqual(await snapshot(), before);
  }
});

test("independent database connections share allocations and retain the counter after reconnecting", async () => {
  const other = await mongoose.createConnection(mongo.getUri()).asPromise();
  try {
    const numbers = await Promise.all(Array.from({ length: 30 }, (_, i) => nextEmployeeNumber(i % 2 ? db : other.db)));
    assert.equal(new Set(numbers).size, 30);
    assert.deepEqual(numbers.sort(), Array.from({ length: 30 }, (_, i) => `EMP-${String(i + 1).padStart(6, "0")}`));
  } finally {
    await other.close();
  }
  const reconnected = await mongoose.createConnection(mongo.getUri()).asPromise();
  try {
    assert.equal(await nextEmployeeNumber(reconnected.db), "EMP-000031");
  } finally {
    await reconnected.close();
  }
});

test("migration reseeds a stale counter without decreasing an existing high counter", async () => {
  await seed();
  await db.collection("counters").insertOne({ _id: "employeeNumber", value: 2 });
  await migrateEmployeeNumbers(db, { dryRun: false });
  assert.equal(await nextEmployeeNumber(db), "EMP-000015");
  await db.collection("counters").updateOne({ _id: "employeeNumber" }, { $set: { value: 100 } });
  await migrateEmployeeNumbers(db, { dryRun: false });
  assert.equal(await nextEmployeeNumber(db), "EMP-000101");
});

test("concurrent assignments survive and interrupted backfills can be rerun", async () => {
  const employees = db.collection("users");
  const { insertedId } = await employees.insertOne({ email: "concurrent@example.com" });
  let changed = false;
  const concurrentDb = {
    collection(name) {
      const collection = db.collection(name);
      return new Proxy(collection, {
        get(target, key) {
          if (name === "users" && key === "updateOne") return async (...args) => {
            if (!changed) {
              changed = true;
              await employees.updateOne({ _id: insertedId }, { $set: { employeeNumber: "WS-CONCURRENT" } });
            }
            return target.updateOne(...args);
          };
          const value = target[key];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  const report = await migrateEmployeeNumbers(concurrentDb, { dryRun: false });
  assert.equal(report.modifiedDocuments, 0);
  assert.equal((await employees.findOne({ _id: insertedId })).employeeNumber, "WS-CONCURRENT");

  await employees.insertMany([{ email: "first@example.com" }, { email: "second@example.com" }]);
  let updates = 0;
  const interruptedDb = {
    collection(name) {
      const collection = db.collection(name);
      return new Proxy(collection, {
        get(target, key) {
          if (name === "users" && key === "updateOne") return async (...args) => {
            if (++updates === 2) throw new Error("Interrupted backfill");
            return target.updateOne(...args);
          };
          const value = target[key];
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  await assert.rejects(migrateEmployeeNumbers(interruptedDb, { dryRun: false }), /Interrupted backfill/);
  const first = await employees.findOne({ email: "first@example.com" });
  assert.match(first.employeeNumber, /^EMP-\d{6}$/);
  assert.equal((await migrateEmployeeNumbers(db, { dryRun: false })).modifiedDocuments, 1);
  assert.equal((await employees.findOne({ _id: first._id })).employeeNumber, first.employeeNumber);
});

test("empty databases work and sequence exhaustion cannot wrap or reset the counter", async () => {
  assert.equal((await migrateEmployeeNumbers(db)).before.documents, 0);
  assert.equal((await migrateEmployeeNumbers(db, { dryRun: false })).modifiedDocuments, 0);
  await assert.rejects(migrateEmployeeNumbers(db, { batchSize: 0 }), /positive integer/);
  await db.collection("counters").updateOne({ _id: "employeeNumber" }, { $set: { value: Number.MAX_SAFE_INTEGER } });
  await assert.rejects(nextEmployeeNumber(db), /exhausted or invalid/);
  assert.equal((await db.collection("counters").findOne({ _id: "employeeNumber" })).value, Number.MAX_SAFE_INTEGER);
});

test("migration CLI defaults to audit, applies explicitly, and needs no JWT secret", async () => {
  await seed();
  const before = await snapshot();
  const env = { ...process.env, MONGO_URI: mongo.getUri() };
  delete env.JWT_ACCESS_SECRET;
  const script = path.resolve(__dirname, "../scripts/migrate-employee-numbers.js");
  const { stdout } = await run(process.execPath, [script], { env });
  assert.equal(JSON.parse(stdout).dryRun, true);
  assert.deepEqual(await snapshot(), before);
  const applied = await run(process.execPath, [script, "--apply"], { env });
  assert.equal(JSON.parse(applied.stdout).after.missingNumbers, 0);
  for (const args of [["--unknown"], ["--apply", "--dry-run"]]) {
    await assert.rejects(run(process.execPath, [script, ...args], { env }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Usage:/);
      return true;
    });
  }
});
