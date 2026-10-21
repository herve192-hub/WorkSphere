const mongoose = require("mongoose");
const Employee = require("./Employee");
const AppError = require("../../utils/AppError");
const { withDomainTransaction } = require("../../services/transaction");

/**
 * Statuses that disqualify an employee from supervising others.
 * @type {Set<string>}
 */
const UNAVAILABLE_STATUSES = new Set(["INACTIVE", "TERMINATED"]);

/**
 * Statuses that are still eligible to act as a manager.
 * @type {Set<string>}
 */
const AVAILABLE_STATUSES = new Set(["ACTIVE", "ON_LEAVE"]);

/**
 * Coordinates hierarchy writes across all API processes using one MongoDB guard.
 * Every transaction writes the guard before reading relationships, forcing a write
 * conflict when two snapshots compete. MongoDB retries the losing transaction with
 * fresh reads. There is no lease to expire while a process is paused or crashes.
 * @param {(session: import('mongoose').ClientSession) => Promise<any>} operation
 * @returns {Promise<any>}
 */
async function withHierarchyWrite(operation) {
  const guards = mongoose.connection.db.collection("employee_hierarchy_guards");
  const key = { _id: "reporting-hierarchy" };
  // Seed outside the transaction: concurrent first-use upserts may race on _id.
  try {
    await guards.updateOne(key, { $setOnInsert: { revision: 0 } }, { upsert: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  return withDomainTransaction(async (session) => {
    await guards.updateOne(key, { $inc: { revision: 1 } }, { session });
    return operation(session);
  });
}

/**
 * Validates that a manager assignment does not create a self-reference, cycle,
 * missing ancestor, or an invalid manager status.
 *
 * @param {string|undefined|null} employeeId - The employee being reassigned.
 * @param {string|undefined|null} managerId - The proposed manager id.
 * @param {import('mongoose').ClientSession | null} [session] - Optional DB session.
 * @returns {Promise<void>}
 * @throws {AppError}
 */
async function validateManager(employeeId, managerId, session) {
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
    const manager = await Employee.findById(currentId).select("managerId employmentStatus").session(session || null).lean();
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

/**
 * Prevents deleting or deactivating a manager while they still have direct reports.
 *
 * @param {string} employeeId - The manager id being checked.
 * @param {import('mongoose').ClientSession | null} [session] - Optional DB session.
 * @returns {Promise<void>}
 * @throws {AppError}
 */
async function ensureNoDirectReports(employeeId, session) {
  const directReportCount = await Employee.countDocuments({ managerId: employeeId }).session(session || null);
  if (directReportCount)
    throw new AppError(409, "MANAGER_HAS_DIRECT_REPORTS", "Reassign or explicitly clear all direct reports before deleting this manager or marking them inactive or terminated.", { directReportCount });
}

module.exports = { UNAVAILABLE_STATUSES, withHierarchyWrite, validateManager, ensureNoDirectReports };
