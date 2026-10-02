const AppError = require("../utils/AppError");
const { normalizeNameInput } = require("./names");

const STATUSES = ["ACTIVE", "ON_LEAVE", "INACTIVE", "TERMINATED"];
const writableFields = [
  "firstName",
  "lastName",
  "email",
  "employeeNumber",
  "phone",
  "jobTitle",
  "department",
  "employmentStatus",
  "hireDate",
  "managerId",
  "location",
  "avatarUrl",
];

function cleanString(value, field, maxLength, { required = false } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && !value.trim())) {
    throw new AppError(400, "VALIDATION_ERROR", `${field} is invalid.`);
  }
  const clean = value.trim();
  if (clean.length > maxLength) {
    throw new AppError(400, "VALIDATION_ERROR", `${field} is too long.`);
  }
  return clean;
}

function employeePayload(body = {}, { partial = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new AppError(400, "VALIDATION_ERROR", "Provide an employee object.");
  const source = normalizeNameInput(body);
  const data = {};
  for (const field of writableFields) {
    if (source[field] !== undefined) data[field] = source[field];
  }

  const required = !partial;
  if (required || data.firstName !== undefined)
    data.firstName = cleanString(data.firstName, "First name", 80, { required: true });
  if (required || data.lastName !== undefined)
    data.lastName = cleanString(data.lastName, "Last name", 80, { required: true });
  if (required || data.email !== undefined) {
    const email = cleanString(data.email, "Email", 254, { required: true });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new AppError(400, "VALIDATION_ERROR", "Enter a valid email address.");
    data.email = email.toLowerCase();
  }

  for (const [field, max] of [["employeeNumber", 40], ["phone", 40], ["jobTitle", 120], ["department", 120], ["location", 160], ["avatarUrl", 500]]) {
    if (data[field] !== undefined) data[field] = cleanString(data[field], field, max);
  }

  if (data.employmentStatus !== undefined && !STATUSES.includes(data.employmentStatus))
    throw new AppError(400, "VALIDATION_ERROR", "Employment status is invalid.");

  if (data.employeeNumber === "")
    throw new AppError(400, "VALIDATION_ERROR", "Employee number must not be blank.");

  if (data.managerId !== undefined && data.managerId !== null &&
      (typeof data.managerId !== "string" || !/^[a-f0-9]{24}$/i.test(data.managerId)))
    throw new AppError(400, "VALIDATION_ERROR", "Manager ID is invalid.");

  if (data.avatarUrl) {
    let url;
    try { url = new URL(data.avatarUrl); } catch {}
    if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new AppError(400, "VALIDATION_ERROR", "Avatar URL must be an HTTP or HTTPS URL without credentials.");
  }

  if (data.hireDate !== undefined && data.hireDate !== null && data.hireDate !== "") {
    const value = data.hireDate;
    // Accept a calendar date or a UTC ISO timestamp; reject rollover dates.
    if (typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value))
      throw new AppError(400, "VALIDATION_ERROR", "Hire date is invalid.");
    const date = new Date(value);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10))
      throw new AppError(400, "VALIDATION_ERROR", "Hire date is invalid.");
    data.hireDate = date;
  } else if (data.hireDate === "") data.hireDate = null;

  if (partial && Object.keys(data).length === 0)
    throw new AppError(400, "VALIDATION_ERROR", "Provide at least one employee field to update.");

  return data;
}

const SORT_FIELDS = new Set(["firstName", "lastName", "email", "employeeNumber", "department", "jobTitle", "hireDate", "createdAt"]);

function employeeQuery(query = {}) {
  const data = { page: 1, limit: 20, sortBy: "createdAt", sortOrder: "desc" };
  for (const key of Object.keys(query)) {
    if (!["page", "limit", "sortBy", "sortOrder", "search", "department", "status"].includes(key) ||
        typeof query[key] !== "string")
      throw new AppError(400, "VALIDATION_ERROR", "Invalid employee query parameter.");
    data[key] = query[key].trim();
  }
  for (const key of ["page", "limit"]) {
    if (!/^[1-9]\d*$/.test(String(data[key])) || !Number.isSafeInteger(Number(data[key])))
      throw new AppError(400, "VALIDATION_ERROR", key + " must be a positive integer.");
    data[key] = Number(data[key]);
  }
  if (data.sortBy === "firstname") data.sortBy = "firstName";
  if (data.sortBy === "lastname") data.sortBy = "lastName";
  if (data.limit > 100 || !Number.isSafeInteger((data.page - 1) * data.limit) ||
      !SORT_FIELDS.has(data.sortBy) || !["asc", "desc"].includes(data.sortOrder))
    throw new AppError(400, "VALIDATION_ERROR", "Invalid pagination or sorting parameters.");
  if (data.status !== undefined) {
    data.status = data.status.toUpperCase();
    if (!STATUSES.includes(data.status))
      throw new AppError(400, "VALIDATION_ERROR", "Employment status is invalid.");
  }
  for (const [key, max] of [["search", 254], ["department", 120]]) {
    if (data[key] !== undefined) data[key] = cleanString(data[key], key, max);
  }
  return data;
}

module.exports = { employeePayload, employeeQuery, STATUSES };
