const mongoose = require("mongoose");
const AuditEvent = require("./AuditEvent");
const AppError = require("../../utils/AppError");
const { auditDocument } = require("./document");

/**
 * Transitional synchronous projection of the producer's pending envelope.
 * Require the same client's active transaction as its outbox and business write.
 * Propagate errors so all three roll back; the caller commits with majority write
 * concern. Delivery later uses this identical projection to recognize the record.
 * Never call the independent consumer here: it would commit outside this session.
 */
async function appendEnvelope(input, { producer, session } = {}) {
  if (!session?.inTransaction() || session.client !== mongoose.connection.getClient())
    throw new TypeError("Immediate audit history requires an active transaction from the audit database client.");
  const [event] = await AuditEvent.create([auditDocument(input, producer)], { session });
  return event;
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

module.exports = { appendEnvelope, listEvents, getEvent, queryOptions };
