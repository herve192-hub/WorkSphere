const mongoose = require("mongoose");
// Preserve the original directory collection; identities live separately in accounts.
module.exports = mongoose.model(
  "Employee",
  new mongoose.Schema(
    {
      firstname: { type: String, required: true },
      lastname: { type: String, required: true },
      email: { type: String, required: true, unique: true },
    },
    { timestamps: true },
  ),
  "users",
);
