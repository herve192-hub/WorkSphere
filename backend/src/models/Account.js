const mongoose = require("mongoose");
module.exports = mongoose.model(
  "Account",
  new mongoose.Schema(
    {
      firstname: { type: String, required: true },
      lastname: { type: String, required: true },
      email: { type: String, required: true, unique: true },
      passwordHash: { type: String, required: true, select: false },
      role: {
        type: String,
        enum: ["ADMIN", "HR_MANAGER", "EMPLOYEE"],
        default: "EMPLOYEE",
      },
    },
    { timestamps: true },
  ),
);
