const { randomUUID } = require("node:crypto");

// Keep the producer contract independent of Audit's database models so each
// producer can persist its own outbox after the services are extracted.
const AUDIT_ACTIONS = Object.freeze([
  "EMPLOYEE_CREATED", "EMPLOYEE_UPDATED", "EMPLOYEE_DELETED",
  "AUTH_REGISTERED", "AUTH_LOGIN", "AUTH_LOGIN_FAILED", "AUTH_REFRESHED", "AUTH_LOGOUT",
]);
const EMPLOYEE_AUDIT_FIELDS = Object.freeze([
  "firstName", "lastName", "email", "employeeNumber", "phone", "jobTitle",
  "department", "employmentStatus", "hireDate", "managerId", "location", "avatarUrl",
]);
const PRODUCERS = Object.freeze({ employees: "EMPLOYEE", identity: "ACCOUNT" });
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const MAX_AUDIT_EVENT_BYTES = 64 * 1024;

/** Fail closed on unexpected properties rather than silently retaining credentials. */
function object(value, keys, name) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some((key) => !keys.includes(key)))
    throw new TypeError(`Invalid audit ${name}.`);
}

function text(value, maximum, name, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > maximum)
    throw new TypeError(`Invalid audit ${name}.`);
  return value;
}

function identifier(value, name) {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) throw new TypeError(`Invalid audit ${name}.`);
  return value.toLowerCase();
}

/**
 * Build a detached version-1 event body from explicitly allowed, already-redacted
 * domain data. The outbox adds the sequence inside the business transaction.
 * Metadata is allocated once per enqueue and retained for every later delivery.
 * @param {object} payload - action, actor, resource, requestId, and optional changes.
 * @param {object} metadata - Trusted producer, eventId, and occurrence timestamp.
 */
function prepareAuditEvent(payload, { producer, eventId = randomUUID(), occurredAt = new Date().toISOString() } = {}) {
  object(payload, ["action", "actor", "resource", "requestId", "changes"], "payload");
  if (!Object.hasOwn(PRODUCERS, producer) || !AUDIT_ACTIONS.includes(payload.action) ||
      payload.action.startsWith("EMPLOYEE_") !== (producer === "employees"))
    throw new TypeError("Invalid audit producer/action combination.");
  if (typeof eventId !== "string" || !UUID_V4.test(eventId)) throw new TypeError("Invalid audit event ID.");
  if (typeof occurredAt !== "string" || !Number.isFinite(Date.parse(occurredAt)) ||
      new Date(occurredAt).toISOString() !== occurredAt)
    throw new TypeError("Invalid audit occurrence timestamp.");
  const requestId = text(payload.requestId, 128, "request ID");
  if (!/^[A-Za-z0-9._:-]+$/.test(requestId)) throw new TypeError("Invalid audit request ID.");

  object(payload.resource, ["type", "id", "label"], "resource");
  if (payload.resource.type !== PRODUCERS[producer]) throw new TypeError("Invalid audit resource type.");
  const failedLogin = payload.action === "AUTH_LOGIN_FAILED";
  const resource = {
    type: payload.resource.type,
    id: failedLogin ? null : identifier(payload.resource.id, "resource ID"),
    label: text(payload.resource.label, 254, "resource label", true),
  };
  // Failed authentication has no verified identity. Never retain attempted email
  // addresses or submitted credentials as an actor, target, label, or change.
  if (failedLogin && (payload.actor !== null || payload.resource.id !== null || resource.label !== ""))
    throw new TypeError("Failed-login audit events must be anonymous.");
  let actor = null;
  if (!failedLogin) {
    object(payload.actor, ["id", "firstName", "lastName", "email", "role"], "actor");
    if (!["ADMIN", "HR_MANAGER", "EMPLOYEE"].includes(payload.actor.role)) throw new TypeError("Invalid audit actor role.");
    actor = {
      id: identifier(payload.actor.id, "actor ID"),
      firstName: text(payload.actor.firstName, 80, "actor first name"),
      lastName: text(payload.actor.lastName, 80, "actor last name"),
      email: text(payload.actor.email, 254, "actor email"),
      role: payload.actor.role,
    };
    if (producer === "identity" && actor.id !== resource.id) throw new TypeError("Invalid audit account identity.");
  }

  const inputChanges = payload.changes === undefined ? [] : payload.changes;
  if (!Array.isArray(inputChanges) || inputChanges.length > EMPLOYEE_AUDIT_FIELDS.length ||
      (producer === "identity" && inputChanges.length)) throw new TypeError("Invalid audit changes.");
  const seen = new Set();
  // Visit sparse array slots too: Array#map would silently turn a missing change
  // into JSON null, producing an envelope a future consumer cannot validate.
  const changes = Array.from(inputChanges, (change) => {
    object(change, ["field", "before", "after"], "change");
    if (!EMPLOYEE_AUDIT_FIELDS.includes(change.field) || seen.has(change.field)) throw new TypeError("Invalid audit change field.");
    seen.add(change.field);
    // Directory snapshots use strings/null. Objects could smuggle unbounded or
    // sensitive nested data through a nominally allowed field.
    const scalar = (value) => value === null ? null : text(value, 4096, "change value", true);
    return { field: change.field, before: scalar(change.before), after: scalar(change.after) };
  });
  const event = {
    eventId: eventId.toLowerCase(), schemaVersion: 1, producer, occurredAt,
    action: payload.action, actor, resource, requestId, changes,
  };
  // Reserve the largest valid sequence representation so the final wire envelope
  // remains bounded even with multibyte text or JSON-escaped change values.
  if (Buffer.byteLength(JSON.stringify({ ...event, sequence: Number.MAX_SAFE_INTEGER }), "utf8") > MAX_AUDIT_EVENT_BYTES)
    throw new RangeError("Audit event exceeds the 64 KiB envelope limit.");
  return event;
}

/**
 * Validate a delivered envelope without allocating IDs, timestamps, or defaults.
 * Reuse the producer's redaction rules, but require every wire field so malformed
 * deliveries cannot acquire a different identity or meaning on each retry.
 * This checks data integrity; the receiving transport must authenticate producers.
 */
function validateAuditEnvelope(input) {
  const keys = ["eventId", "schemaVersion", "producer", "sequence", "occurredAt", "action", "actor", "resource", "requestId", "changes"];
  object(input, keys, "envelope");
  if (keys.some((key) => !Object.hasOwn(input, key) || input[key] === undefined))
    throw new TypeError("Audit envelope fields are required.");
  if (input.schemaVersion !== 1) throw new TypeError("Unsupported audit schema version.");
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1)
    throw new TypeError("Invalid audit event sequence.");
  const { eventId, producer, occurredAt, action, actor, resource, requestId, changes } = input;
  return { ...prepareAuditEvent({ action, actor, resource, requestId, changes }, { producer, eventId, occurredAt }), sequence: input.sequence };
}

module.exports = { AUDIT_ACTIONS, EMPLOYEE_AUDIT_FIELDS, MAX_AUDIT_EVENT_BYTES, prepareAuditEvent, validateAuditEnvelope };
