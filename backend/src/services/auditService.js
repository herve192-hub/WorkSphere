const mongoose = require("mongoose");
const AuditEvent = require("../models/AuditEvent");
const AppError = require("../utils/AppError");
const { resolvedNames } = require("./names");

// Only directory fields are eligible for history. Never copy request bodies,
// account documents, passwords, cookies, tokens, or headers into an event.
const fields = [
  "firstName", "lastName", "email", "employeeNumber", "phone", "jobTitle",
  "department", "employmentStatus", "hireDate", "managerId", "location", "avatarUrl",
];

/**
 * Coerces a value into a stable audit-safe string representation.
 *
 * @param {*} input - Value to normalize for persistence in audit records.
 * @returns {string|null} Stringified value, or null when the input is absent.
 */
function value(input) {
  if (input == null) return null;
  if (input instanceof Date) return input.toISOString();
  return String(input);
}

/**
 * Builds a redacted snapshot of an employee with only directory-safe fields.
 *
 * @param {object} employee - Employee document or plain object being audited.
 * @returns {object|null} Snapshot containing only tracked employee fields.
 */
function employeeSnapshot(employee) {
  if (!employee) return null;
  const data = employee.toObject ? employee.toObject() : employee;
  const names = resolvedNames(data);
  return Object.fromEntries(fields.map((field) => [field, value(names[field] ?? data[field])]));
}

/**
 * Creates the minimal audit-friendly actor payload.
 *
 * @param {object} actor - User or system actor associated with an event.
 * @returns {object|null} Snapshot of the actor without sensitive metadata.
 */
function actorSnapshot(actor) {
  return actor ? { id: actor._id, ...resolvedNames(actor), email: actor.email, role: actor.role } : null;
}

/**
 * Persists a raw audit event record with actor/resource metadata.
 *
 * @param {object} params - Event payload.
 * @param {string} params.action - Action code recorded in the audit log.
 * @param {object} params.actor - User or system actor triggering the action.
 * @param {object} params.resource - Resource metadata for the audited entity.
 * @param {string} [params.requestId] - Optional correlation ID for the request.
 * @param {Array<object>} [params.changes=[]] - Detailed field-level diffs.
 * @param {import('mongoose').ClientSession} [session] - Optional MongoDB session.
 * @returns {Promise<object>} Created audit event document.
 */
async function appendEvent({ action, actor, resource, requestId, changes = [] }, session) {
  const [event] = await AuditEvent.create([{
    action, actor: actorSnapshot(actor), resource, requestId, changes,
  }], session ? { session } : {});
  return event;
}

/**
 * Records employee field changes as an audit event.
 *
 * @param {string} action - Audit action identifier.
 * @param {object} context - Additional event metadata such as actor and requestId.
 * @param {object} before - Employee state before the change.
 * @param {object} after - Employee state after the change.
 * @param {import('mongoose').ClientSession} [session] - Optional MongoDB session.
 * @returns {Promise<object>} Created audit event for the employee change.
 */
async function recordEmployeeChange(action, context, before, after, session) {
  const previous = employeeSnapshot(before);
  const current = employeeSnapshot(after);
  const employee = after || before;
  const changes = fields.flatMap((field) => {
    const oldValue = previous?.[field] ?? null;
    const newValue = current?.[field] ?? null;
    return oldValue === newValue ? [] : [{ field, before: oldValue, after: newValue }];
  });
  return appendEvent({
    action, ...context,
    resource: { type: "EMPLOYEE", id: employee._id, label: employee.employeeNumber || String(employee._id) },
    changes,
  }, session);
}

/**
 * Validates and normalizes audit listing query parameters.
 *
 * @param {object} [query={}] - Incoming query string values from the API layer.
 * @returns {object} Sanitized audit query options with pagination and filters.
 * @throws {AppError} When a query parameter is invalid.
 */
function queryOptions(query = {}) {
  const options = { page: 1, limit: 20 };
  for (const [key, input] of Object.entries(query)) {
    if (!["page", "limit", "action", "actorId", "resourceType", "resourceId", "from", "to", "search"].includes(key) || typeof input !== "string")
      throw new AppError(400, "VALIDATION_ERROR", "Invalid audit query parameter.");
    options[key] = input.trim();
  }
  for (const key of ["page", "limit"]) {
    if (!/^[1-9]\d*$/.test(String(options[key])) || !Number.isSafeInteger(Number(options[key])))
      throw new AppError(400, "VALIDATION_ERROR", `${key} must be a positive integer.`);
    options[key] = Number(options[key]);
  }
  if (options.limit > 100 || !Number.isSafeInteger((options.page - 1) * options.limit))
    throw new AppError(400, "VALIDATION_ERROR", "Invalid audit pagination.");
  if (options.action !== undefined && !AuditEvent.ACTIONS.includes(options.action))
    throw new AppError(400, "VALIDATION_ERROR", "Audit action is invalid.");
  if (options.resourceType !== undefined && !["EMPLOYEE", "ACCOUNT"].includes(options.resourceType))
    throw new AppError(400, "VALIDATION_ERROR", "Audit resource type is invalid.");
  for (const key of ["actorId", "resourceId"]) {
    if (options[key] !== undefined && !mongoose.isObjectIdOrHexString(options[key]))
      throw new AppError(400, "VALIDATION_ERROR", `${key} is invalid.`);
  }
  for (const key of ["from", "to"]) {
    if (options[key] === undefined) continue;
    const input = options[key];
    const date = new Date(input);
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(input) ||
        Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input.slice(0, 10))
      throw new AppError(400, "VALIDATION_ERROR", `${key} must be a calendar date or UTC timestamp.`);
    if (key === "to" && input.length === 10) date.setUTCHours(23, 59, 59, 999);
    options[key] = date;
  }
  if (options.from && options.to && options.from > options.to)
    throw new AppError(400, "VALIDATION_ERROR", "The audit date range is invalid.");
  if (options.search !== undefined && options.search.length > 254)
    throw new AppError(400, "VALIDATION_ERROR", "Audit search is too long.");
  return options;
}

/**
 * Lists audit events with filtering, pagination, and search support.
 *
 * @param {object} [query={}] - Normalized query parameters.
 * @returns {Promise<object>} Paginated audit event collection.
 */
async function listEvents(query) {
  const options = queryOptions(query);
  const filter = {};
  if (options.action) filter.action = options.action;
  if (options.actorId) filter["actor.id"] = options.actorId;
  if (options.resourceType) filter["resource.type"] = options.resourceType;
  if (options.resourceId) filter["resource.id"] = options.resourceId;
  if (options.from || options.to) {
    filter.occurredAt = {};
    if (options.from) filter.occurredAt.$gte = options.from;
    if (options.to) filter.occurredAt.$lte = options.to;
  }
  if (options.search) {
    const pattern = new RegExp(options.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = ["resource.label", "actor.firstName", "actor.lastName", "actor.email"].map((key) => ({ [key]: pattern }));
  }
  const { page, limit } = options;
  const [data, totalItems] = await Promise.all([
    AuditEvent.find(filter).sort({ occurredAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AuditEvent.countDocuments(filter),
  ]);
  return { data, pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) } };
}

/**
 * Fetches a single audit event by ID.
 *
 * @param {string} id - MongoDB ObjectId for the audit event.
 * @returns {Promise<object>} Audit event document.
 * @throws {AppError} When the ID is invalid or no event matches.
 */
async function getEvent(id) {
  if (!mongoose.isObjectIdOrHexString(id)) throw new AppError(400, "INVALID_AUDIT_ID", "Invalid audit ID.");
  const event = await AuditEvent.findById(id).lean();
  if (!event) throw new AppError(404, "AUDIT_NOT_FOUND", "Audit event not found.");
  return event;
}

module.exports = { appendEvent, recordEmployeeChange, listEvents, getEvent, queryOptions };
