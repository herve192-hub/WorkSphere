const { NAME_FIELDS, resolvedNames } = require("../services/names");

const COLLECTIONS = ["accounts", "users"];
const projection = Object.fromEntries(NAME_FIELDS.flat().map((field) => [field, 1]));
const owns = (document, field) => Object.hasOwn(document, field);

function validNames(document) {
  return Object.values(resolvedNames(document)).every((value) =>
    typeof value === "string" && value.trim().length > 0 && value.trim().length <= 80,
  );
}

async function inspectCollection(collection) {
  const report = {
    documents: 0,
    documentsToBackfill: 0,
    documentsWithLegacyNames: 0,
    conflictingDocuments: 0,
    invalidDocuments: 0,
  };
  // Read only name fields; credentials and other employee data never leave MongoDB.
  for await (const document of collection.find({}, { projection })) {
    report.documents++;
    if (NAME_FIELDS.some(([canonical, legacy]) => document[canonical] == null && document[legacy] != null))
      report.documentsToBackfill++;
    if (NAME_FIELDS.some(([, legacy]) => owns(document, legacy))) report.documentsWithLegacyNames++;
    if (NAME_FIELDS.some(([canonical, legacy]) =>
      document[canonical] != null && document[legacy] != null && document[canonical] !== document[legacy],
    )) report.conflictingDocuments++;
    if (!validNames(document)) report.invalidDocuments++;
  }
  return report;
}

async function inspectNames(db) {
  const report = {};
  for (const name of COLLECTIONS) report[name] = await inspectCollection(db.collection(name));
  return report;
}

function migrationError(message, report) {
  return Object.assign(new Error(message), { report });
}

async function updateCollection(collection, { cleanup, batchSize }) {
  let operations = [];
  let modifiedDocuments = 0;
  async function flush() {
    if (!operations.length) return;
    const result = await collection.bulkWrite(operations, { ordered: false });
    modifiedDocuments += result.modifiedCount;
    operations = [];
  }

  for await (const document of collection.find({}, { projection })) {
    if (!validNames(document))
      throw new Error("Name data changed during the migration. Fix invalid records and rerun.");
    const update = {};
    for (const [canonical, legacy] of NAME_FIELDS) {
      if (document[canonical] == null) {
        update.$set ||= {};
        update.$set[canonical] = document[legacy];
      }
      if (cleanup && owns(document, legacy)) {
        update.$unset ||= {};
        update.$unset[legacy] = "";
      }
    }
    if (!Object.keys(update).length) continue;

    // Compare all four fields to the snapshot so a concurrent name change cannot
    // be overwritten or deleted. Skipped records are caught by the final audit.
    const filter = { _id: document._id };
    for (const field of NAME_FIELDS.flat()) {
      filter[field] = owns(document, field)
        ? { $exists: true, $eq: document[field] }
        : { $exists: false };
    }
    operations.push({ updateOne: { filter, update } });
    if (operations.length >= batchSize) await flush();
  }
  await flush();
  return modifiedDocuments;
}

async function migrateNames(db, { dryRun = true, cleanup = false, batchSize = 500 } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new Error("Migration batch size must be a positive integer.");
  const before = await inspectNames(db);
  const report = { dryRun, phase: cleanup ? "cleanup" : "backfill", before };
  if (dryRun) return report;
  if (Object.values(before).some((collection) => collection.invalidDocuments))
    throw migrationError("Invalid name records found. Fix them before applying the migration.", report);

  // Backfill retains the old index until the explicit cleanup phase.
  await db.collection("users").createIndex({ lastName: 1, firstName: 1 });
  report.modifiedDocuments = {};
  for (const name of COLLECTIONS) {
    report.modifiedDocuments[name] = await updateCollection(db.collection(name), { cleanup, batchSize });
  }
  report.after = await inspectNames(db);
  if (Object.values(report.after).some((collection) =>
    collection.invalidDocuments || collection.documentsToBackfill ||
    (cleanup && collection.documentsWithLegacyNames),
  )) throw migrationError("Name data changed during the migration. Inspect the report and rerun.", report);

  if (cleanup) {
    const indexes = await db.collection("users").listIndexes().toArray();
    const legacyIndex = indexes.find((index) => index.name === "lastname_1_firstname_1" &&
      Object.keys(index.key).length === 2 && index.key.lastname === 1 && index.key.firstname === 1);
    if (legacyIndex) await db.collection("users").dropIndex(legacyIndex.name);
  }
  return report;
}

module.exports = { inspectNames, migrateNames };
