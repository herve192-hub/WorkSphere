const mongoose = require("mongoose");
const { addNameFields } = require("../services/names");
const { nextEmployeeNumber } = require("../services/employeeNumbers");

const employeeSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    employeeNumber: { type: String, required: true, immutable: true, unique: true, sparse: true, trim: true, maxlength: 40 },
    phone: { type: String, trim: true, maxlength: 40, default: "" },
    jobTitle: { type: String, trim: true, maxlength: 120, default: "" },
    department: { type: String, trim: true, maxlength: 120, default: "" },
    employmentStatus: {
      type: String,
      enum: ["ACTIVE", "ON_LEAVE", "INACTIVE", "TERMINATED"],
      default: "ACTIVE",
      index: true,
    },
    hireDate: { type: Date, default: null },
    managerId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    location: { type: String, trim: true, maxlength: 160, default: "" },
    avatarUrl: { type: String, trim: true, maxlength: 500, default: "" },
  },
  { timestamps: true },
);
addNameFields(employeeSchema);

employeeSchema.pre("validate", async function () {
  if (!this.isNew) return;
  // Keep the same allocation if a new document is validated or saved again.
  this.$locals.employeeNumber ||= await nextEmployeeNumber(this.constructor.db.db);
  this.employeeNumber = this.$locals.employeeNumber;
});

employeeSchema.index({ department: 1, employmentStatus: 1 });
employeeSchema.index({ lastName: 1, firstName: 1 });

// Preserve the existing collection while the application is migrated incrementally.
module.exports = mongoose.model("Employee", employeeSchema, "users");
