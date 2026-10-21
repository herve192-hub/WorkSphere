// Audit visibility is eventually consistent by default. The synchronous projection
// remains an explicit rollback mode; both modes always capture durable intent.
function auditDeliveryMode(input = process.env.AUDIT_DELIVERY_MODE) {
  const mode = input === undefined ? "async" : input;
  if (!["async", "sync"].includes(mode)) throw new TypeError("AUDIT_DELIVERY_MODE must be async or sync.");
  return mode;
}

const VISIBILITY_TARGET_MS = 10000;
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_STALE_MS = 30000;
module.exports = { auditDeliveryMode, VISIBILITY_TARGET_MS, HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS };
