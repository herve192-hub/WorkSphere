const mongoose = require("mongoose");
const { createAuditOutbox } = require("../../outbox");
const { actorSnapshot } = require("../../services/auditSnapshot");
const { appendEnvelope } = require("../audit/index");
const { auditDeliveryMode } = require("../../outbox/policy");

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
  // Cookies are still issued only after business state and intent commit. Receiver
  // outages defer visibility; synchronous rollback mode retains the same identity.
  if (auditDeliveryMode() === "sync") await appendEnvelope(event, { producer: "identity", session });
}

module.exports = { initialize, recordAuthEvent };
