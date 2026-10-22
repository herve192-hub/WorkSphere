const jwt = require("jsonwebtoken");
const { validateAuditEnvelope } = require("../contracts/auditEvent");
const { ISSUER, AUDIENCE, MAX_TOKEN_AGE_SECONDS, MAX_RETRY_AFTER_MS } = require("../contracts/auditService");

const DELIVERY_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 4096;
class AuditHttpDeliveryError extends Error {
  constructor(code, retryAfterMs) {
    super("Audit HTTP delivery did not acknowledge durable history.");
    this.code = code;
    if (retryAfterMs) this.retryAfterMs = retryAfterMs;
  }
}
const failure = (code, retryAfterMs) => new AuditHttpDeliveryError(code, retryAfterMs);

/** Configuration only: callers never choose an origin, path, or redirect target. */
function deliveryOrigin(input) {
  let url;
  try { url = new URL(input); } catch { throw new TypeError("AUDIT_SERVICE_URL must be an absolute HTTP(S) origin."); }
  if (typeof input !== "string" || input !== input.trim() || !["http:", "https:"].includes(url.protocol) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new TypeError("AUDIT_SERVICE_URL must be an HTTP(S) origin without credentials, path, query, or fragment.");
  return url.origin;
}

function producerKey(key) {
  if (typeof key !== "string" || Buffer.byteLength(key) < 32 || /^replace-/i.test(key))
    throw new TypeError("Audit producer credentials must be random secrets of at least 32 bytes.");
  return key;
}

function retryDelay(value) {
  if (!value) return undefined;
  // Honor delta seconds or HTTP dates, bounded to one day. Hints are a minimum
  // delay, independent of the worker's exponential-backoff cap, never a busy wait.
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? Math.min(MAX_RETRY_AFTER_MS, Math.ceil(delay)) : undefined;
}

/** Bound decoded bytes as well as time, including chunked/compressed responses. */
async function readJson(response) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") || "") ||
      Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES || !response.body)
    throw failure("AUDIT_INVALID_ACKNOWLEDGMENT");
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw failure("AUDIT_INVALID_ACKNOWLEDGMENT");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw failure("AUDIT_INVALID_ACKNOWLEDGMENT"); }
}

/**
 * One HTTP attempt outside any producer transaction; the worker owns retries.
 * A fresh producer token authenticates each attempt. Never send API credentials,
 * follow redirects, log remote content, or fall back to a local history write.
 */
function createAuditHttpDelivery({ url, producer, key, timeoutMs = DELIVERY_TIMEOUT_MS }) {
  const endpoint = `${deliveryOrigin(url)}/internal/v1/events`;
  if (!["employees", "identity"].includes(producer)) throw new TypeError("Unknown Audit HTTP producer.");
  producerKey(key);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DELIVERY_TIMEOUT_MS)
    throw new TypeError("Audit HTTP deadline must be between 1 and 8000 milliseconds.");
  return async (input, context = {}) => {
    const event = validateAuditEnvelope(input);
    if (event.producer !== producer || context.producer !== producer)
      throw new TypeError("Audit HTTP delivery requires the configured producer identity.");
    const controller = new AbortController();
    const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs).unref();
    let response;
    try {
      const token = jwt.sign({}, key, { algorithm: "HS256", issuer: ISSUER, audience: AUDIENCE,
        subject: producer, expiresIn: MAX_TOKEN_AGE_SECONDS });
      response = await fetch(endpoint, { method: "POST", redirect: "error", signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Request-Id": event.requestId },
        body: JSON.stringify(event) });
      if (response.status === 429 || response.status === 503)
        throw failure(response.status === 429 ? "AUDIT_DELIVERY_RATE_LIMITED" : "AUDIT_DELIVERY_FAILED", retryDelay(response.headers.get("retry-after")));
      if ([401, 403].includes(response.status)) throw failure("AUDIT_DELIVERY_UNAUTHORIZED");
      if (![200, 201, 409].includes(response.status)) throw failure("AUDIT_DELIVERY_FAILED");
      const body = await readJson(response);
      if (response.status === 409) {
        if (body?.error?.code === "AUDIT_DELIVERY_CONFLICT") throw failure("AUDIT_DELIVERY_CONFLICT");
        throw failure("AUDIT_INVALID_ACKNOWLEDGMENT");
      }
      const ack = body?.data;
      if (!body || Object.keys(body).length !== 1 || !ack || Object.keys(ack).length !== 4 ||
          ack.eventId !== event.eventId || ack.producer !== producer ||
          typeof ack.auditId !== "string" || !/^[a-f0-9]{24}$/.test(ack.auditId) ||
          ack.duplicate !== (response.status === 200))
        throw failure("AUDIT_INVALID_ACKNOWLEDGMENT");
      return { auditId: ack.auditId, duplicate: ack.duplicate };
    } catch (error) {
      if (signal.aborted) throw failure("AUDIT_DELIVERY_TIMEOUT");
      // Only locally constructed codes escape; native/remote errors can include
      // URLs, credentials, or content and must not reach logs or retained state.
      if (error instanceof AuditHttpDeliveryError) throw error;
      throw failure("AUDIT_DELIVERY_FAILED");
    } finally {
      clearTimeout(timer);
      controller.abort(); // Also releases unread/oversized error response bodies.
    }
  };
}

module.exports = { createAuditHttpDelivery, deliveryOrigin, producerKey };
