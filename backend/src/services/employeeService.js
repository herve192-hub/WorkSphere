const mongoose = require("mongoose");
const Employee = require("../models/Employee");
const AppError = require("../utils/AppError");
const { employeePayload, employeeQuery } = require("./employeeValidation");
const { NAME_FIELDS, publicNames, nameExpressions } = require("./names");

function publicEmployee(employee) {
  const data = employee.toObject ? employee.toObject() : employee;
  return { ...data, ...publicNames(data) };
}

function ensureId(id) {
  if (!mongoose.isObjectIdOrHexString(id))
    throw new AppError(400, "INVALID_EMPLOYEE_ID", "Invalid employee ID.");
}

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

async function createEmployee(body) {
  return publicEmployee(await Employee.create(employeePayload(body)));
}

async function updateEmployee(id, body) {
  ensureId(id);
  const data = employeePayload(body, { partial: true });
  const update = { $set: data };
  for (const [canonical, legacy] of NAME_FIELDS) {
    if (data[canonical] !== undefined) {
      update.$unset ||= {};
      update.$unset[legacy] = "";
    }
  }
  const employee = await Employee.findByIdAndUpdate(id, update, {
    new: true,
    runValidators: true,
  });
  if (!employee) throw new AppError(404, "EMPLOYEE_NOT_FOUND", "Employee not found.");
  return publicEmployee(employee);
}

async function deleteEmployee(id) {
  ensureId(id);
  const employee = await Employee.findByIdAndDelete(id);
  if (!employee) throw new AppError(404, "EMPLOYEE_NOT_FOUND", "Employee not found.");
}

module.exports = { listEmployees, getEmployee, createEmployee, updateEmployee, deleteEmployee };
