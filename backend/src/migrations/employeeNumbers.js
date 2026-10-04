const { initializeEmployeeNumberCounter, nextEmployeeNumber } = require("../services/employeeNumbers");

function needsEmployeeNumber(value) {
  return value == null || (typeof value === "string" && !value.trim());
}

async function inspectEmployeeNumbers(db) {
  const employees = db.collection("users");
  const report = { documents: 0, missingNumbers: 0, invalidNumbers: 0, duplicateNumbers: 0 };
  for await (const employee of employees.find({}, { projection: { employeeNumber: 1 } })) {
    report.documents++;
    if (needsEmployeeNumber(employee.employeeNumber)) report.missingNumbers++;
    else if (typeof employee.employeeNumber !== "string" || employee.employeeNumber.length > 40)
      report.invalidNumbers++;
  }
  const duplicates = await employees.aggregate([
    { $match: { employeeNumber: { $type: "string", $regex: /\S/ } } },
    { $group: { _id: "$employeeNumber", count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $count: "count" },
  ]).toArray();
  report.duplicateNumbers = duplicates[0]?.count || 0;
  return report;
}

async function migrateEmployeeNumbers(db, { dryRun = true, batchSize = 500 } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new Error("Migration batch size must be a positive integer.");
  const before = await inspectEmployeeNumbers(db);
  const report = { dryRun, before };
  if (dryRun) return report;
  if (before.invalidNumbers || before.duplicateNumbers)
    throw Object.assign(new Error("Fix invalid or duplicate employee numbers before applying the migration."), { report });

  await initializeEmployeeNumberCounter(db, { reseed: true });
  const employees = db.collection("users");
  report.modifiedDocuments = 0;
  const cursor = employees.find({}, { projection: { employeeNumber: 1 } }).sort({ _id: 1 }).batchSize(batchSize);
  for await (const employee of cursor) {
    if (!needsEmployeeNumber(employee.employeeNumber)) continue;
    const filter = {
      _id: employee._id,
      employeeNumber: Object.hasOwn(employee, "employeeNumber")
        ? { $exists: true, $eq: employee.employeeNumber }
        : { $exists: false },
    };
    // A concurrent assignment wins; only the missing value we read is replaced.
    const result = await employees.updateOne(filter, {
      $set: { employeeNumber: await nextEmployeeNumber(db) },
    });
    report.modifiedDocuments += result.modifiedCount;
  }
  report.after = await inspectEmployeeNumbers(db);
  if (report.after.missingNumbers || report.after.invalidNumbers || report.after.duplicateNumbers)
    throw Object.assign(new Error("Employee number data changed during migration. Inspect the report and rerun."), { report });
  await employees.createIndex({ employeeNumber: 1 }, { unique: true, sparse: true });
  return report;
}

module.exports = { inspectEmployeeNumbers, migrateEmployeeNumbers };
