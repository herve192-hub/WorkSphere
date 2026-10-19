const mongoose = require("mongoose");
const Employee = require("./Employee");
const AppError = require("../../utils/AppError");
const { employeePayload, employeeQuery } = require("./validation");
const { NAME_FIELDS, publicNames, nameExpressions } = require("../../services/names");
const { UNAVAILABLE_STATUSES, withHierarchyWrite, validateManager, ensureNoDirectReports } = require("./hierarchy");
const { recordEmployeeChange } = require("../audit/index");

/**
 * Employee service layer for listing, reading, creating, updating, and deleting
 * employee records while enforcing hierarchy rules and user visibility checks.
 */

/**
 * Returns a safe representation of an employee for API responses.
 *
 * @param {object|{ toObject: () => object }} employee - Mongoose document or plain object.
 * @returns {object} Public employee payload with legacy name aliases stripped.
 */
function publicEmployee(employee) {
  const data = employee.toObject ? employee.toObject() : employee;
  return { ...data, ...publicNames(data) };
}

/**
 * Validates an employee identifier before a lookup or mutation attempt.
 *
 * @param {string} id - MongoDB ObjectId value.
 * @throws {AppError} When the ID is not a valid ObjectId string.
 */
function ensureId(id) {
  if (!mongoose.isObjectIdOrHexString(id))
    throw new AppError(400, "INVALID_EMPLOYEE_ID", "Invalid employee ID.");
}

/**
 * Builds the Mongo filter used for employee list queries.
 *
 * @param {object} query - Request query parameters.
 * @param {{ role?: string, email?: string }} user - Current authenticated user.
 * @returns {object} MongoDB filter object.
 */
function buildFilter(query, user) {
  const filter = user.role === "EMPLOYEE" ? { email: user.email } : {};
  if (query.department) filter.department = String(query.department).trim();
  if (query.status) filter.employmentStatus = String(query.status).trim().toUpperCase();
  if (query.search) {
    const escaped = String(query.search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (escaped) {
      const pattern = new RegExp(escaped, "i");
      filter.$or = [
        { firstName: pattern }, { lastName: pattern },
        { firstName: null, firstname: pattern }, { lastName: null, lastname: pattern },
        { email: pattern },
        { employeeNumber: pattern }, { jobTitle: pattern }, { department: pattern },
      ];
    }
  }
  return filter;
}

async function listEmployees(query, user) {
  query = employeeQuery(query);
  const { page, limit, sortBy } = query;
  const filter = buildFilter(query, user);
  const sortOrder = query.sortOrder === "asc" ? 1 : -1;
  const sort = { [sortBy]: sortOrder, _id: sortOrder };
  const skip = (page - 1) * limit;
  // Resolve names before sorting so pagination works across mixed old/new data.
  const records = nameExpressions[sortBy]
    ? Employee.aggregate([
      { $match: filter },
      { $set: { [sortBy]: nameExpressions[sortBy] } },
      { $sort: sort }, { $skip: skip }, { $limit: limit },
    ])
    : Employee.find(filter).sort(sort).skip(skip).limit(limit).lean();

  const [data, totalItems] = await Promise.all([
    records,
    Employee.countDocuments(filter),
  ]);

  return {
    data: data.map(publicEmployee),
    pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) },
  };
}

async function getEmployee(id, user) {
  ensureId(id);
  const employee = await Employee.findById(id).lean();
  if (!employee) throw new AppError(404, "EMPLOYEE_NOT_FOUND", "Employee not found.");
  if (user.role === "EMPLOYEE" && employee.email !== user.email)
    throw new AppError(403, "FORBIDDEN", "You do not have permission to view this employee.");
  return publicEmployee(employee);
}

async function createEmployee(body, context) {
  const employee = new Employee(employeePayload(body));
  // Allocate outside the transaction: failed creates still leave number gaps.
  await employee.validate();
  const transact = employee.managerId == null ? (operation) => mongoose.connection.transaction(operation) : withHierarchyWrite;
  return transact(async (session) => {
    await validateManager(employee._id, employee.managerId, session);
    await employee.save({ session });
    await recordEmployeeChange("EMPLOYEE_CREATED", context, null, employee, session);
    return publicEmployee(employee);
  });
}

async function updateEmployee(id, body, context) {
  ensureId(id);
  const data = employeePayload(body, { partial: true });
  const update = { $set: data };
  for (const [canonical, legacy] of NAME_FIELDS) {
    if (data[canonical] !== undefined) {
      update.$unset ||= {};
      update.$unset[legacy] = "";
    }
  }
  const changesHierarchy = data.managerId !== undefined || data.employmentStatus !== undefined;
  // Hierarchy checks and the write share the transaction that owns the guard.
  const transact = changesHierarchy ? withHierarchyWrite : (operation) => mongoose.connection.transaction(operation);
  return transact(async (session) => {
    const before = await Employee.findById(id).session(session).lean();
    if (!before) throw new AppError(404, "EMPLOYEE_NOT_FOUND", "Employee not found.");
    if (changesHierarchy) {
      if (data.managerId !== undefined) await validateManager(id, data.managerId, session);
      if (UNAVAILABLE_STATUSES.has(data.employmentStatus)) await ensureNoDirectReports(id, session);
    }
    const employee = await Employee.findByIdAndUpdate(id, update, {
      new: true,
      runValidators: true,
      session,
    });
    if (!employee) throw new AppError(404, "EMPLOYEE_NOT_FOUND", "Employee not found.");
    await recordEmployeeChange("EMPLOYEE_UPDATED", context, before, employee, session);
    return publicEmployee(employee);
  });
}

async function deleteEmployee(id, context) {
  ensureId(id);
  return withHierarchyWrite(async (session) => {
    const before = await Employee.findById(id).session(session).lean();
    if (!before)
      throw new AppError(404, "EMPLOYEE_NOT_FOUND", "Employee not found.");
    await ensureNoDirectReports(id, session);
    const employee = await Employee.findByIdAndDelete(id, { session });
    if (!employee) throw new AppError(404, "EMPLOYEE_NOT_FOUND", "Employee not found.");
    await recordEmployeeChange("EMPLOYEE_DELETED", context, before, null, session);
  });
}

module.exports = { listEmployees, getEmployee, createEmployee, updateEmployee, deleteEmployee };
