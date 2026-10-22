const { auditDocument } = require("./document");
const { AUDIT_COLLECTION, initializeAuditStorage } = require("./storage");

/** A valid envelope reused an immutable delivery identity or stream position. */
class AuditDeliveryConflict extends Error {
  constructor(reason) {
    super("Audit delivery conflicts with recorded history.");
    this.name = "AuditDeliveryConflict";
    this.code = "AUDIT_DELIVERY_CONFLICT";
    this.reason = reason;
  }
}

/**
 * Create an internal Audit receiver on an explicit native MongoDB Db. It owns no
 * connection and exposes no HTTP route. A future transport must authenticate its
 * producer independently of the envelope and pass that trusted identity to consume.
 */
function createAuditConsumer(db) {
  const events = db.collection(AUDIT_COLLECTION);
  let initialized = false;
  // A duplicate may race an uncommitted write on another client. Acknowledge only
  // majority-visible history, using the primary rather than a lagging secondary.
  const lookupOptions = { readConcern: { level: "majority" }, readPreference: "primary", projection: { _id: 1, "_delivery.fingerprint": 1 } };

  return {
    /** Required before delivery; concurrent startups preserve all existing history. */
    async initialize() {
      initialized = false;
      // Include query indexes on the supplied database without loading an API model.
      await initializeAuditStorage(db);
      initialized = true;
    },

    /**
     * Persist once, or acknowledge an identical retry with the original audit ID.
     * Never overwrite history. Validation/conflict errors require investigation;
     * storage failures propagate so the sender retains and retries its event.
     * This method owns its majority write, outside the producer's transaction.
     */
    async consume(input, { producer } = {}) {
      if (!initialized) throw new Error("Audit consumer must be initialized before delivery.");
      const document = auditDocument(input, producer);
      const { eventId, streamId, sequence, fingerprint } = document._delivery;
      const identity = { "_delivery.producer": producer, "_delivery.eventId": eventId };
      try {
        await events.insertOne(document, { writeConcern: { w: "majority" } });
        return { auditId: document._id.toHexString(), duplicate: false };
      } catch (error) {
        if (error.code !== 11000) throw error;
        const existing = await events.findOne(identity, lookupOptions);
        if (existing) {
          if (existing._delivery.fingerprint !== fingerprint) throw new AuditDeliveryConflict("EVENT_ID_REUSED");
          return { auditId: existing._id.toHexString(), duplicate: true };
        }
        const position = await events.findOne({
          "_delivery.producer": producer, "_delivery.streamId": streamId, "_delivery.sequence": sequence,
        }, lookupOptions);
        if (position) throw new AuditDeliveryConflict("STREAM_SEQUENCE_REUSED");
        // A conflicting write may not yet be majority-visible (or may roll back).
        // Preserve the storage error; absence is never proof of successful delivery.
        throw error;
      }
    },
  };
}

module.exports = { createAuditConsumer, AuditDeliveryConflict };
