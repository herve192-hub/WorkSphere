const mongoose = require("mongoose");
const Employee = require("../models/Employee");
const AppError = require("../utils/AppError");

const UNAVAILABLE_STATUSES = new Set(["INACTIVE", "TERMINATED"]);
const AVAILABLE_STATUSES = new Set(["ACTIVE", "ON_LEAVE"]);

// The current API runs as one process. Serialize reporting changes so competing
// assignments, status changes, and deletes cannot pass stale relationship checks.
// Multiple API processes require a shared lock or transaction-based coordination.
let pendingWrite = Promise.resolve();
function withHierarchyWrite(operation) {
  const result = pendingWrite.then(operation);
  pendingWrite = result.catch(() => {});
  return result;
}

async function validateManager(employeeId, managerId) {
  if (managerId == null) return;
  const employeeKey = String(employeeId).toLowerCase();
  let currentId = managerId;
  const visited = new Set();
  while (currentId != null) {
    if (!mongoose.isObjectIdOrHexString(currentId))
      throw new AppError(409, "INVALID_MANAGER_HIERARCHY", "The selected manager has an invalid reporting chain. Correct it before assigning this manager.");
    const key = String(currentId).toLowerCase();
    if (key === employeeKey) {
      if (!visited.size)
        throw new AppError(400, "SELF_MANAGEMENT", "An employee cannot be their own manager.");
      throw new AppError(400, "REPORTING_CYCLE", "This manager assignment would create a reporting cycle.");
    }
    if (visited.has(key))
      throw new AppError(400, "REPORTING_CYCLE", "The selected manager's reporting chain already contains a cycle.");
    const manager = await Employee.findById(currentId).select("managerId employmentStatus").lean();
    if (!manager) {
      if (!visited.size)
        throw new AppError(400, "MANAGER_NOT_FOUND", "The selected manager does not exist.");
      throw new AppError(409, "INVALID_MANAGER_HIERARCHY", "The selected manager has a missing manager in their reporting chain. Correct it before assigning this manager.");
    }
    if (!visited.size && !AVAILABLE_STATUSES.has(manager.employmentStatus ?? "ACTIVE"))
      throw new AppError(400, "MANAGER_UNAVAILABLE", "Only active employees or employees on leave can be assigned as a manager.");
    visited.add(key);
    currentId = manager.managerId;
  }
}

async function ensureNoDirectReports(employeeId) {
  const directReportCount = await Employee.countDocuments({ managerId: employeeId });
  if (directReportCount)
    throw new AppError(409, "MANAGER_HAS_DIRECT_REPORTS", "Reassign or explicitly clear all direct reports before deleting this manager or marking them inactive or terminated.", { directReportCount });
}

module.exports = { UNAVAILABLE_STATUSES, withHierarchyWrite, validateManager, ensureNoDirectReports };
