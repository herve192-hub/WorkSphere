const mongoose = require("mongoose");
const { createAuditOutbox } = require("../../outbox");
const { EMPLOYEE_AUDIT_FIELDS } = require("../../contracts/auditEvent");
const { actorSnapshot } = require("../../services/auditSnapshot");
const { resolvedNames } = require("../../services/names");
const { appendEnvelope } = require("../audit/index");
const { auditDeliveryMode } = require("../../outbox/policy");

// Key by Db so reconnecting cannot accidentally reuse another client's outbox.
// Startup initializes explicitly; importing a maintenance command performs no writes.
const outboxes = new WeakMap();
async function initialize() {
  const db = mongoose.connection.db;
  outboxes.delete(db);
  const outbox = createAuditOutbox(db, "employees");
  await outbox.initialize();
  outboxes.set(db, outbox);
}

/** Employee owns field selection; whole documents and request bodies never leave it. */
function employeeSnapshot(employee) {
  if (!employee) return null;
  const data = employee.toObject ? employee.toObject() : employee;
  const names = resolvedNames(data);
  return Object.fromEntries(EMPLOYEE_AUDIT_FIELDS.map((field) => {
    const input = names[field] ?? data[field];
    return [field, input == null ? null : input instanceof Date ? input.toISOString() : String(input)];
  }));
}

async function recordEmployeeChange(action, context, before, after, session) {
  const outbox = outboxes.get(mongoose.connection.db);
  if (!outbox) throw new Error("Employee audit outbox must be initialized before writes.");
  const previous = employeeSnapshot(before);
  const current = employeeSnapshot(after);
  const employee = after || before;
  const changes = EMPLOYEE_AUDIT_FIELDS.flatMap((field) => {
    const oldValue = previous?.[field] ?? null;
    const newValue = current?.[field] ?? null;
    return oldValue === newValue ? [] : [{ field, before: oldValue, after: newValue }];
  });
  const event = await outbox.enqueue({
    action, actor: actorSnapshot(context.actor), requestId: context.requestId,
    resource: { type: "EMPLOYEE", id: String(employee._id), label: employee.employeeNumber || String(employee._id) }, changes,
  }, { session });
  // Async writes depend only on durable producer storage. Explicit rollback mode
  // projects the same envelope in this transaction, preserving replay identity.
  if (auditDeliveryMode() === "sync") await appendEnvelope(event, { producer: "employees", session });
}

module.exports = { initialize, recordEmployeeChange };
