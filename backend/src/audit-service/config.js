const { isIP } = require("node:net");
const CLIENTS = Object.freeze(["employees", "identity", "api"]);

/** Separate service credentials; never accept the browser access-token secret. */
function validateServiceKeys(input, accessSecret) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype ||
      Object.keys(input).length !== CLIENTS.length || CLIENTS.some((name) => !Object.hasOwn(input, name)))
    throw new Error("AUDIT_SERVICE_KEYS must contain exactly employees, identity, and api keys.");
  const values = CLIENTS.map((name) => input[name]);
  if (values.some((key) => typeof key !== "string" || Buffer.byteLength(key) < 32 || /^replace-/i.test(key)) ||
      new Set(values).size !== CLIENTS.length || values.includes(accessSecret))
    throw new Error("Audit service keys must be distinct random secrets of at least 32 bytes, separate from JWT_ACCESS_SECRET.");
  return Object.freeze({ ...input });
}

/** Explicit Audit configuration prevents accidental fallback to the business DB. */
function loadAuditServiceConfig(input = process.env) {
  const mongoUri = input.AUDIT_MONGO_URI;
  if (typeof mongoUri !== "string" || !/^mongodb(?:\+srv)?:\/\/\S+$/.test(mongoUri))
    throw new Error("AUDIT_MONGO_URI is required.");
  let parsed;
  try { parsed = JSON.parse(input.AUDIT_SERVICE_KEYS); }
  catch { throw new Error("AUDIT_SERVICE_KEYS must be a JSON object."); }
  const keys = validateServiceKeys(parsed, input.JWT_ACCESS_SECRET);
  const host = input.AUDIT_HOST ?? "127.0.0.1";
  const rawPort = input.AUDIT_PORT ?? "5001";
  // Port zero is useful for isolated test processes; log the actual bound port.
  if (!isIP(host) || !/^(0|[1-9]\d{0,4})$/.test(rawPort) || Number(rawPort) > 65535)
    throw new Error("Audit requires a literal IP address and a port between 0 and 65535.");
  return Object.freeze({ mongoUri, keys, host, port: Number(rawPort) });
}

module.exports = { loadAuditServiceConfig, validateServiceKeys };
