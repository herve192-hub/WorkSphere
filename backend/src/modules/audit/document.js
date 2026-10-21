const { createHash } = require("node:crypto");
const { Types } = require("mongoose");
const { validateAuditEnvelope } = require("../../contracts/auditEvent");

/**
 * Both immediate history and later delivery must project the same envelope and
 * fingerprint. Allocating a new event identity here would duplicate replayed history.
 * The producer argument comes from trusted application code or an authenticated transport.
 */
function auditDocument(input, producer) {
  const event = validateAuditEnvelope(input);
  if (producer !== event.producer) throw new TypeError("Audit delivery producer does not match its trusted source.");
  // Canonical validation normalizes object key order and IDs; the digest also
  // retains metadata and change-array order without storing another PII snapshot.
  const fingerprint = createHash("sha256").update(JSON.stringify(event)).digest("hex");
  return {
    _id: new Types.ObjectId(), action: event.action,
    actor: event.actor ? { ...event.actor, id: new Types.ObjectId(event.actor.id) } : null,
    resource: { ...event.resource, id: event.resource.id ? new Types.ObjectId(event.resource.id) : null },
    changes: event.changes, requestId: event.requestId, occurredAt: new Date(event.occurredAt),
    _delivery: { producer, eventId: event.eventId,
      streamId: `${event.resource.type}:${event.resource.id || event.eventId}`, sequence: event.sequence, fingerprint },
  };
}

module.exports = { auditDocument };
