const mongoose = require("mongoose");
const { AUDIT_ACTIONS } = require("../../contracts/auditEvent");
const { AUDIT_COLLECTION, AUDIT_INDEXES, DELIVERY_INDEXES } = require("./storage");

/**
 * Canonical set of audit actions recorded by the platform.
 * These are the only valid values for the `action` field on audit events.
 * @type {string[]}
 */
const ACTIONS = AUDIT_ACTIONS;

/**
 * Minimal identity snapshot for the actor who triggered an audit event.
 * Stored as a nested document to keep audit records self-contained.
 */
const actorSchema = new mongoose.Schema({
  id: { type: mongoose.Schema.Types.ObjectId, required: true },
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true },
  role: { type: String, enum: ["ADMIN", "HR_MANAGER", "EMPLOYEE"], required: true },
}, { _id: false });

/**
 * A single field-level diff captured before and after a mutation.
 */
const changeSchema = new mongoose.Schema({
  field: { type: String, required: true },
  before: { type: mongoose.Schema.Types.Mixed, default: null },
  after: { type: mongoose.Schema.Types.Mixed, default: null },
}, { _id: false });

// Delivery identity lives in the same document as history: one atomic insert
// both records the event and makes retries detectable, without a separate receipt.
const deliverySchema = new mongoose.Schema({
  producer: { type: String, enum: ["employees", "identity"], required: true },
  eventId: { type: String, required: true },
  streamId: { type: String, required: true },
  sequence: { type: Number, required: true },
  fingerprint: { type: String, required: true },
}, { _id: false });

/**
 * Audit log entry for employee and account lifecycle events.
 * Includes who performed the action, what resource was impacted,
 * which fields changed, and when the action occurred.
 */
const auditSchema = new mongoose.Schema({
  action: { type: String, enum: ACTIONS, required: true },
  actor: { type: actorSchema, default: null },
  resource: {
    type: { type: String, enum: ["EMPLOYEE", "ACCOUNT"], required: true },
    id: { type: mongoose.Schema.Types.ObjectId, default: null },
    label: { type: String, default: "" },
  },
  changes: { type: [changeSchema], default: [] },
  requestId: { type: String, required: true, maxlength: 128 },
  occurredAt: { type: Date, required: true, default: Date.now },
  // Internal deduplication metadata must never change the public audit API shape.
  _delivery: { type: deliverySchema, select: false, default: undefined },
}, { versionKey: false });

// The monolith and an independently connected receiver initialize the same
// index definitions, preserving existing names during a rolling deployment.
for (const { key, ...options } of AUDIT_INDEXES) auditSchema.index(key, options);

module.exports = mongoose.model("AuditEvent", auditSchema, AUDIT_COLLECTION);
module.exports.ACTIONS = ACTIONS;
module.exports.DELIVERY_INDEXES = DELIVERY_INDEXES;
