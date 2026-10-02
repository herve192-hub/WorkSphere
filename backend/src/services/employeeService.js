const mongoose = require("mongoose");
const Employee = require("../models/Employee");
const AppError = require("../utils/AppError");
const { employeePayload, employeeQuery } = require("./employeeValidation");

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
        { firstname: pattern }, { lastname: pattern }, { email: pattern },
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

  const [data, totalItems] = await Promise.all([
    Employee.find(filter).sort({ [sortBy]: sortOrder, _id: sortOrder }).skip((page - 1) * limit).limit(limit).lean(),
    Employee.countDocuments(filter),
  ]);

  return {
    data,
    pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) },
  };
}

async function getEmployee(id, user) {
  ensureId(id);
  const employee = await Employee.findById(id).lean();
  if (!employee) throw new AppError(404, "EMPLOYEE_NOT_FOUND", "Employee not found.");
  if (user.role === "EMPLOYEE" && employee.email !== user.email)
    throw new AppError(403, "FORBIDDEN", "You do not have permission to view this employee.");
  return employee;
}

async function createEmployee(body) {
  return Employee.create(employeePayload(body));
}

async function updateEmployee(id, body) {
  ensureId(id);
  const employee = await Employee.findByIdAndUpdate(id, employeePayload(body, { partial: true }), {
    new: true,
    runValidators: true,
  });
  if (!employee) throw new AppError(404, "EMPLOYEE_NOT_FOUND", "Employee not found.");
  return employee;
}

async function deleteEmployee(id) {
  ensureId(id);
  const employee = await Employee.findByIdAndDelete(id);
  if (!employee) throw new AppError(404, "EMPLOYEE_NOT_FOUND", "Employee not found.");
}

module.exports = { listEmployees, getEmployee, createEmployee, updateEmployee, deleteEmployee };
