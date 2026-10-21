const { prepareAuditEvent } = require("../contracts/auditEvent");

// Collection ownership follows the producer, even while both domains currently
// share a database. The same factory can use a domain's private database later.
const COLLECTIONS = Object.freeze({
  employees: { events: "employee_audit_outbox", sequences: "employee_audit_sequences" },
  identity: { events: "identity_audit_outbox", sequences: "identity_audit_sequences" },
});

function outboxCollections(producer) {
  if (!Object.hasOwn(COLLECTIONS, producer)) throw new TypeError("Unknown audit outbox producer.");
  return COLLECTIONS[producer];
}

/**
 * Create transaction-only audit storage for a producer on an explicit MongoDB Db.
 * This module owns no connection and performs no writes merely by being imported.
 * @param {import('mongodb').Db} db - The producing domain's database.
 * @param {'employees'|'identity'} producer - Fixed for this factory instance.
 */
function createAuditOutbox(db, producer) {
  const names = outboxCollections(producer);
  const events = db.collection(names.events);
  const sequences = db.collection(names.sequences);
  let initialized = false;

  return {
    /** Initialize explicitly before accepting writes; concurrent startups are safe. */
    async initialize() {
      initialized = false;
      for (const name of Object.values(names)) {
        try { await db.createCollection(name); }
        catch (error) { if (error.code !== 48) throw error; } // NamespaceExists.
      }
      await events.createIndexes([
        { key: { streamId: 1, "event.sequence": 1 }, name: "audit_stream_sequence", unique: true },
        { key: { status: 1, availableAt: 1, _id: 1 }, name: "audit_pending_delivery" },
      ]);
      initialized = true;
      // No TTL: pending events must survive an arbitrarily long delivery outage.
      // Sequence documents also survive cleanup so a stream never reuses a number.
    },

    /**
     * Append alongside the business write, using the SAME client's transaction.
     * Propagate failures out of the callback so MongoDB rolls back both writes.
     * The caller's withTransaction/Connection.transaction handles transient retries;
     * never retry this insert independently of the business operation.
     * Commit with majority write concern before acknowledging the business write;
     * an insert inside a transaction cannot strengthen its caller's commit policy.
     */
    async enqueue(payload, { session, eventId, occurredAt } = {}) {
      // Fail before a transaction can implicitly create collections without the
      // required indexes if a producer forgot to await startup initialization.
      if (!initialized) throw new Error("Audit outbox must be initialized before enqueue.");
      if (!session?.inTransaction() || session.client !== db.client)
        throw new TypeError("Audit outbox requires an active transaction from the producing database client.");
      const event = prepareAuditEvent(payload, { producer, eventId, occurredAt });
      // Failed logins have no resource ID; each is its own independent stream.
      const streamId = `${event.resource.type}:${event.resource.id || event.eventId}`;
      const counter = await sequences.findOneAndUpdate(
        { _id: streamId }, { $inc: { value: 1 }, $currentDate: { allocatedAt: true } },
        { upsert: true, returnDocument: "after", session },
      );
      if (!Number.isSafeInteger(counter.value) || counter.value < 1)
        throw new RangeError("Audit event sequence is exhausted or invalid.");
      event.sequence = counter.value;
      // Initial readiness and backlog age use the same database clock as leases
      // and health. Producer clock skew may affect occurrence time, never delivery.
      const now = counter.allocatedAt;
      await events.insertOne({
        _id: event.eventId, streamId, event,
        status: "PENDING", attempts: 0, availableAt: now, createdAt: now,
      }, { session });
      // Duplicate event IDs fail on _id and abort the enclosing transaction. A
      // later consumer will deduplicate deliveries, not silently replace events.
      return event;
    },
  };
}

module.exports = { createAuditOutbox, outboxCollections };
