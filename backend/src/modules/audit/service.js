const mongoose = require("mongoose");
const AuditEvent = require("./AuditEvent");
const { auditDocument } = require("./document");
const { createAuditReader, queryOptions } = require("./reader");

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

// Only this monolith adapter selects the API connection. Construct per call so
// reconnects cannot retain an obsolete Db; independent runtimes supply their own
// Db directly to createAuditReader without importing authentication or API config.
function listEvents(query) { return createAuditReader(mongoose.connection.db).listEvents(query); }
function getEvent(id) { return createAuditReader(mongoose.connection.db).getEvent(id); }

module.exports = { appendEnvelope, listEvents, getEvent, queryOptions };
