const mongoose = require("mongoose");
const { createAuditOutbox } = require("../../outbox");
const { actorSnapshot } = require("../../services/auditSnapshot");
const { appendEnvelope } = require("../audit/index");

// Explicit startup and per-Db ownership keep reconnects and maintenance imports safe.
const outboxes = new WeakMap();
async function initialize() {
  const db = mongoose.connection.db;
  outboxes.delete(db);
  const outbox = createAuditOutbox(db, "identity");
  await outbox.initialize();
  outboxes.set(db, outbox);
}

/** Capture verified identity fields only; failed logins remain fully anonymous. */
async function recordAuthEvent(req, action, actor, session) {
  const outbox = outboxes.get(mongoose.connection.db);
  if (!outbox) throw new Error("Identity audit outbox must be initialized before writes.");
  const event = await outbox.enqueue({
    action, actor: actorSnapshot(actor), requestId: req.requestId,
    resource: { type: "ACCOUNT", id: actor ? String(actor._id) : null, label: actor?.email || "" }, changes: [],
  }, { session });
  // History remains synchronous until delivery/replay are proven safe. Both paths
  // share metadata, and their writes must roll back with account/session changes.
  await appendEnvelope(event, { producer: "identity", session });
}

module.exports = { initialize, recordAuthEvent };
