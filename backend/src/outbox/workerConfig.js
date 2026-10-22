const { deliveryOrigin, producerKey } = require("./httpDelivery");

/** Validate remote configuration before connecting or initializing any database. */
function loadAuditWorkerConfig(input = process.env) {
  const transport = input.AUDIT_WORKER_TRANSPORT ?? "local";
  if (!["local", "http"].includes(transport)) throw new TypeError("AUDIT_WORKER_TRANSPORT must be local or http.");
  if (transport === "local") return { transport };
  if ((input.AUDIT_DELIVERY_MODE ?? "async") !== "async")
    throw new TypeError("Remote Audit delivery requires async mode; synchronous rollback needs colocated storage.");
  const url = deliveryOrigin(input.AUDIT_SERVICE_URL);
  const keys = { employees: producerKey(input.AUDIT_EMPLOYEES_KEY), identity: producerKey(input.AUDIT_IDENTITY_KEY) };
  if (keys.employees === keys.identity || Object.values(keys).includes(input.JWT_ACCESS_SECRET))
    throw new TypeError("Audit producer secrets must be distinct from each other and the browser signing secret.");
  return { transport, url, keys };
}

module.exports = { loadAuditWorkerConfig };
