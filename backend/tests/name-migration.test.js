const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { migrateNames } = require("../src/migrations/names");
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
  for (const collection of ["accounts", "users"]) {
    const extra = collection === "accounts"
      ? { passwordHash: "do-not-change", role: "HR_MANAGER" }
      : { department: "Engineering", managerId: new mongoose.Types.ObjectId(), employmentStatus: "ACTIVE" };
    await db.collection(collection).insertMany([
      { firstname: "Legacy", lastname: "Person", email: "legacy@example.com" },
      { firstName: "Modern", lastName: "Person", email: "modern@example.com" },
      { firstName: "Mixed", lastname: "Person", email: "mixed@example.com" },
      { firstName: "Preferred", firstname: "Discarded", lastName: "Canonical", lastname: "Old", email: "conflict@example.com" },
      { firstName: null, firstname: "Nullable", lastName: null, lastname: "Person", email: "null@example.com" },
    ].map(record => ({ ...record, ...extra, createdAt: new Date("2020-01-01"), updatedAt: new Date("2021-01-01"), __v: 3 })));
  }
  await db.collection("users").createIndex({ lastname: 1, firstname: 1 });
  await db.collection("users").createIndex({ email: 1 }, { unique: true });
}

async function snapshot() {
  return {
    accounts: await db.collection("accounts").find().sort({ _id: 1 }).toArray(),
    users: await db.collection("users").find().sort({ _id: 1 }).toArray(),
    indexes: await db.collection("users").listIndexes().toArray(),
  };
}

test("dry runs audit both collections without changing names, metadata, or indexes", async () => {
  await seed();
  const before = await snapshot();
  for (const cleanup of [false, true]) {
    const report = await migrateNames(db, { cleanup });
    assert.equal(report.dryRun, true);
    assert.equal(report.phase, cleanup ? "cleanup" : "backfill");
    for (const collection of ["accounts", "users"]) {
      assert.deepEqual(report.before[collection], {
        documents: 5, documentsToBackfill: 3, documentsWithLegacyNames: 4,
        conflictingDocuments: 1, invalidDocuments: 0,
      });
    }
    assert.deepEqual(await snapshot(), before);
  }
});

test("backfill and cleanup preserve canonical values and other fields and are idempotent", async () => {
  await seed();
  const before = await snapshot();
  const backfill = await migrateNames(db, { dryRun: false, batchSize: 2 });
  assert.deepEqual(backfill.modifiedDocuments, { accounts: 3, users: 3 });
  const backfilled = await snapshot();
  for (const collection of ["accounts", "users"]) {
    assert.deepEqual(backfilled[collection], before[collection].map(record => ({
      ...record, firstName: record.firstName ?? record.firstname, lastName: record.lastName ?? record.lastname,
    })));
  }
  assert.ok(backfilled.indexes.some(index => index.name === "lastName_1_firstName_1"));
  assert.ok(backfilled.indexes.some(index => index.name === "lastname_1_firstname_1"));
  assert.deepEqual((await migrateNames(db, { dryRun: false })).modifiedDocuments, { accounts: 0, users: 0 });
  assert.deepEqual(await snapshot(), backfilled);

  const cleaned = await migrateNames(db, { dryRun: false, cleanup: true, batchSize: 1 });
  assert.deepEqual(cleaned.modifiedDocuments, { accounts: 4, users: 4 });
  const after = await snapshot();
  for (const collection of ["accounts", "users"]) {
    assert.deepEqual(after[collection], backfilled[collection].map(({ firstname, lastname, ...record }) => record));
    assert.equal(cleaned.after[collection].documentsWithLegacyNames, 0);
  }
  assert.ok(after.indexes.some(index => index.name === "lastName_1_firstName_1"));
  assert.ok(after.indexes.some(index => index.name === "email_1" && index.unique));
  assert.ok(!after.indexes.some(index => index.name === "lastname_1_firstname_1"));
  assert.deepEqual((await migrateNames(db, { dryRun: false, cleanup: true })).modifiedDocuments, { accounts: 0, users: 0 });
  assert.deepEqual(await snapshot(), after);
});

test("cleanup can safely backfill and remove legacy fields in one pass", async () => {
  await seed();
  const report = await migrateNames(db, { dryRun: false, cleanup: true });
  assert.deepEqual(report.modifiedDocuments, { accounts: 4, users: 4 });
  const record = await db.collection("accounts").findOne({ email: "conflict@example.com" });
  assert.equal(record.firstName, "Preferred");
  assert.equal(record.lastName, "Canonical");
  assert.equal(record.firstname, undefined);
  assert.equal(record.lastname, undefined);
});

test("invalid records in either collection block all writes before backfill or cleanup", async () => {
  for (const collection of ["accounts", "users"]) {
    for (const names of [
      { firstname: "Missing" }, { firstName: "", firstname: "Fallback", lastName: "Valid" },
      { firstname: 42, lastname: "Valid" }, { firstName: "a".repeat(81), lastName: "Valid" },
      { firstname: "Valid", lastname: { $ne: null } },
    ]) {
      await db.dropDatabase();
      await seed();
      await db.collection(collection).insertOne({ ...names, email: "invalid@example.com" });
      const before = await snapshot();
      assert.equal((await migrateNames(db)).before[collection].invalidDocuments, 1);
      for (const cleanup of [false, true]) {
        await assert.rejects(migrateNames(db, { dryRun: false, cleanup }), error => {
          assert.match(error.message, /Invalid name records/);
          assert.equal(error.report.before[collection].invalidDocuments, 1);
          return true;
        });
        assert.deepEqual(await snapshot(), before);
      }
    }
  }
});

test("empty databases and already migrated data need no data updates", async () => {
  const report = await migrateNames(db, { dryRun: false, cleanup: true });
  assert.deepEqual(report.modifiedDocuments, { accounts: 0, users: 0 });
  assert.equal(report.after.users.documents, 0);
  await assert.rejects(migrateNames(db, { batchSize: 0 }), /positive integer/);
});

test("concurrent name edits are preserved and an incomplete migration can be rerun", async () => {
  for (const cleanup of [false, true]) {
    await db.dropDatabase();
    const users = db.collection("users");
    const { insertedId } = await users.insertOne({ firstname: "Original", lastname: "Person" });
    if (cleanup) await migrateNames(db, { dryRun: false });
    let changed = false;
    const concurrentDb = {
      collection(name) {
        const collection = db.collection(name);
        return new Proxy(collection, {
          get(target, key) {
            if (name === "users" && key === "bulkWrite") return async (...args) => {
              if (!changed) {
                changed = true;
                await users.updateOne({ _id: insertedId }, { $set: { firstname: "Concurrent" } });
              }
              return target.bulkWrite(...args);
            };
            const value = target[key];
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    await assert.rejects(migrateNames(concurrentDb, { dryRun: false, cleanup }), /Name data changed/);
    const preserved = await users.findOne({ _id: insertedId });
    assert.equal(preserved.firstname, "Concurrent");
    assert.equal(preserved.firstName, cleanup ? "Original" : undefined);
    await migrateNames(db, { dryRun: false, cleanup });
    const migrated = await users.findOne({ _id: insertedId });
    assert.equal(migrated.firstName, cleanup ? "Original" : "Concurrent");
    assert.equal(migrated.firstname, cleanup ? undefined : "Concurrent");
  }
});

test("CLI defaults to dry-run, supports explicit cleanup, and needs no JWT secret", async () => {
  await seed();
  const before = await snapshot();
  const env = { ...process.env, MONGO_URI: mongo.getUri() };
  delete env.JWT_ACCESS_SECRET;
  const script = path.resolve(__dirname, "../scripts/migrate-names.js");
  const { stdout } = await run(process.execPath, [script], { env });
  assert.equal(JSON.parse(stdout).dryRun, true);
  assert.deepEqual(await snapshot(), before);
  const applied = await run(process.execPath, [script, "--apply", "--cleanup"], { env });
  assert.equal(JSON.parse(applied.stdout).after.users.documentsWithLegacyNames, 0);
  for (const args of [["--unknown"], ["--apply", "--dry-run"]]) {
    await assert.rejects(run(process.execPath, [script, ...args], { env }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Usage:/);
      return true;
    });
  }
});
