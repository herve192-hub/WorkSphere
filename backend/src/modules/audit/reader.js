const { ObjectId } = require("mongoose").mongo;
const { AUDIT_ACTIONS } = require("../../contracts/auditEvent");
const AppError = require("../../utils/AppError");
const { AUDIT_COLLECTION } = require("./storage");
const OBJECT_ID = /^[a-f0-9]{24}$/i;

/** Validate the public query contract before constructing any MongoDB filters. */
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
  if (options.action !== undefined && !AUDIT_ACTIONS.includes(options.action))
    throw new AppError(400, "VALIDATION_ERROR", "Audit action is invalid.");
  if (options.resourceType !== undefined && !["EMPLOYEE", "ACCOUNT"].includes(options.resourceType))
    throw new AppError(400, "VALIDATION_ERROR", "Audit resource type is invalid.");
  for (const key of ["actorId", "resourceId"]) {
    if (options[key] !== undefined && !OBJECT_ID.test(options[key]))
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

// An inclusive projection keeps both delivery metadata and future private fields
// out of history responses. Retain null actors/resources in legacy/anonymous events.
const projection = {
  _id: 1, action: 1, "actor.id": 1, "actor.firstName": 1, "actor.lastName": 1, "actor.email": 1, "actor.role": 1,
  "resource.type": 1, "resource.id": 1, "resource.label": 1,
  "changes.field": 1, "changes.before": 1, "changes.after": 1, requestId: 1, occurredAt: 1,
};

// MongoDB's dotted projection omits a null parent. The public contract requires
// actor: null for anonymous/legacy history, so restore it without reading private fields.
function publicEvent(event) { return { ...event, actor: event.actor ?? null }; }

/**
 * Read only the explicitly supplied Audit database. Construction performs no
 * I/O, owns no connection, and needs neither account/session access nor an API
 * JWT secret. The caller authenticates/authorizes requests before using this port.
 */
function createAuditReader(db) {
  const events = db.collection(AUDIT_COLLECTION);
  // Bound database work independently of the future HTTP transport deadline.
  // Read majority-visible history from the primary, matching delivery durability.
  const readOptions = { readConcern: { level: "majority" }, readPreference: "primary", maxTimeMS: 5000 };
  return {
    async listEvents(query) {
      const options = queryOptions(query);
      const filter = {};
      if (options.action) filter.action = options.action;
      // Native collections do not perform Mongoose's implicit ObjectId casting.
      if (options.actorId) filter["actor.id"] = new ObjectId(options.actorId);
      if (options.resourceType) filter["resource.type"] = options.resourceType;
      if (options.resourceId) filter["resource.id"] = new ObjectId(options.resourceId);
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
      // Listing and count are separate reads: concurrent delivery may change the
      // count between them. Stable tie-breaking prevents ambiguous page ordering.
      const [data, totalItems] = await Promise.all([
        events.find(filter, { ...readOptions, projection }).sort({ occurredAt: -1, _id: -1 })
          .skip((page - 1) * limit).limit(limit).toArray(),
        events.countDocuments(filter, readOptions),
      ]);
      return { data: data.map(publicEvent), pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) } };
    },
    async getEvent(id) {
      if (typeof id !== "string" || !OBJECT_ID.test(id)) throw new AppError(400, "INVALID_AUDIT_ID", "Invalid audit ID.");
      const event = await events.findOne({ _id: new ObjectId(id) }, { ...readOptions, projection });
      if (!event) throw new AppError(404, "AUDIT_NOT_FOUND", "Audit event not found.");
      return publicEvent(event);
    },
  };
}

module.exports = { createAuditReader, queryOptions };
