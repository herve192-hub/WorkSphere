const mongoose = require("mongoose");
const { addNameFields } = require("../services/names");
const accountSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true, select: false },
    role: {
      type: String,
      enum: ["ADMIN", "HR_MANAGER", "EMPLOYEE"],
      default: "EMPLOYEE",
    },
  },
  { timestamps: true },
);
addNameFields(accountSchema);
module.exports = mongoose.model("Account", accountSchema);
