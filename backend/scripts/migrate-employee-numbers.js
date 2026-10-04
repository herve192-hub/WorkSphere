const mongoose = require("mongoose");
const { migrateEmployeeNumbers } = require("../src/migrations/employeeNumbers");

const usage = `Usage: npm run migrate:employee-numbers -- [--dry-run | --apply]

Default: read-only audit of employee numbers in MONGO_URI.
--apply    Assign numbers to employees without one, preserve existing numbers,
           seed the counter, and ensure the unique index exists.
--dry-run  Audit without changing data, counters, or indexes.

Retire old API writers before applying. See docs/employee-numbers.md.`;

async function main(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    console.log(usage);
    return;
  }
  if (args.some((arg) => !["--dry-run", "--apply"].includes(arg)) ||
      (args.includes("--dry-run") && args.includes("--apply")))
    throw new Error(usage);

  require("dotenv").config();
  try {
    await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/worksphere", {
      autoIndex: false,
      serverSelectionTimeoutMS: 10000,
    });
    console.log(JSON.stringify(await migrateEmployeeNumbers(mongoose.connection.db, {
      dryRun: !args.includes("--apply"),
    }), null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    if (error.report) console.error(JSON.stringify(error.report, null, 2));
    console.error(error.name === "MongooseServerSelectionError"
      ? "Cannot connect to MongoDB. Check MONGO_URI and database availability."
      : error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
