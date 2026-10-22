// Keep this collection name and its indexes stable through service extraction:
// existing history and delivery identities must remain readable and deduplicated.
const AUDIT_COLLECTION = "auditevents";
const QUERY_INDEXES = [
  { key: { occurredAt: -1, _id: -1 }, name: "occurredAt_-1__id_-1" },
  { key: { "resource.type": 1, "resource.id": 1, occurredAt: -1, _id: -1 }, name: "resource.type_1_resource.id_1_occurredAt_-1__id_-1" },
  { key: { "actor.id": 1, occurredAt: -1, _id: -1 }, name: "actor.id_1_occurredAt_-1__id_-1" },
  { key: { action: 1, occurredAt: -1, _id: -1 }, name: "action_1_occurredAt_-1__id_-1" },
];

// Partial indexes preserve pre-outbox history. History and delivery identities
// have no TTL: deleting either could cause a retry to duplicate a retained event.
const DELIVERY_INDEXES = [
  { key: { "_delivery.producer": 1, "_delivery.eventId": 1 }, name: "audit_delivery_identity", unique: true,
    partialFilterExpression: { "_delivery.eventId": { $type: "string" } } },
  { key: { "_delivery.producer": 1, "_delivery.streamId": 1, "_delivery.sequence": 1 }, name: "audit_delivery_sequence", unique: true,
    partialFilterExpression: { "_delivery.eventId": { $type: "string" } } },
];
const AUDIT_INDEXES = [...QUERY_INDEXES, ...DELIVERY_INDEXES];

/** Explicit startup for a supplied Audit database; never initialize other domains. */
async function initializeAuditStorage(db) {
  try { await db.createCollection(AUDIT_COLLECTION); }
  catch (error) { if (error.code !== 48) throw error; } // NamespaceExists.
  await db.collection(AUDIT_COLLECTION).createIndexes(AUDIT_INDEXES);
}

module.exports = { AUDIT_COLLECTION, AUDIT_INDEXES, DELIVERY_INDEXES, initializeAuditStorage };
