const mongoose = require("mongoose");
const { migrateNames } = require("../src/migrations/names");

const usage = `Usage: npm run migrate:names -- [--dry-run | --apply] [--cleanup]

Default: read-only audit of accounts and users in MONGO_URI.
--apply    Backfill firstName/lastName, retaining legacy fields and indexes.
--cleanup  Also remove legacy fields and the old employee name index.
           Use after all legacy API writers have been retired.
--dry-run  Audit the selected phase without changing data or indexes.

Existing non-null camelCase values win when spellings conflict.
Invalid effective names block writes. See docs/name-migration.md for rollout.`;

async function main(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    console.log(usage);
    return;
  }
  if (args.some((arg) => !["--dry-run", "--apply", "--cleanup"].includes(arg)) ||
      (args.includes("--dry-run") && args.includes("--apply")))
    throw new Error(usage);

  // The standalone migration only needs database configuration, not JWT secrets.
  require("dotenv").config();
  try {
    await mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/worksphere", {
      autoIndex: false,
      serverSelectionTimeoutMS: 10000,
    });
    const report = await migrateNames(mongoose.connection.db, {
      dryRun: !args.includes("--apply"),
      cleanup: args.includes("--cleanup"),
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    if (error.report) console.error(JSON.stringify(error.report, null, 2));
    // Connection errors can contain URI credentials; print only migration errors.
    console.error(error.name === "MongooseServerSelectionError"
      ? "Cannot connect to MongoDB. Check MONGO_URI and database availability."
      : error.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
