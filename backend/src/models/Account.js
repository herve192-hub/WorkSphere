/**
 * Account model for authentication and role-based access.
 * Stores the user's email, password hash, and assigned role.
 */
const mongoose = require("mongoose");
const { addNameFields } = require("../services/names");

/**
 * Account schema.
 * Each account is uniquely identified by a required email and may be an admin,
 * HR manager, or employee.
 */
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
