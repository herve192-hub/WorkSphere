// Runs inside the API container belonging to the fresh verification project.
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const Account = require("./src/models/Account");
const Employee = require("./src/models/Employee");

async function seed() {
  const fixtures = JSON.parse(process.argv[2]);
  await mongoose.connect(process.env.MONGO_URI);
  try {
    assert.equal(await Account.countDocuments(), 0, "Browser fixtures require an empty account collection.");
    assert.equal(await Employee.countDocuments(), 0, "Browser fixtures require an empty employee collection.");
    await Promise.all([Account.init(), Employee.init()]);
    const passwordHash = await bcrypt.hash(fixtures.password, 12);
    await Account.create(Object.values(fixtures.accounts).map((account) => ({ ...account, passwordHash })));
    await Employee.create(fixtures.otherEmployee);
    console.log("Seeded browser-only administrator, HR manager, and reference employee.");
  } finally {
    await mongoose.disconnect();
  }
}

seed().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
