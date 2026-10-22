const { randomUUID } = require("node:crypto");
const { createAuditOutbox, outboxCollections } = require("./storage");
const { validateAuditEnvelope } = require("../contracts/auditEvent");
const { MAX_RETRY_AFTER_MS } = require("../contracts/auditService");

const DEFAULTS = Object.freeze({ maxAttempts: 5, leaseMs: 30000, deliveryTimeoutMs: 10000, retryBaseMs: 1000, retryMaxMs: 60000 });
const majority = { writeConcern: { w: "majority" } };
const ready = { $or: [
  { $and: [{ $eq: ["$status", "PENDING"] }, { $lte: ["$availableAt", "$$NOW"] }] },
  { $and: [{ $eq: ["$status", "IN_FLIGHT"] }, { $lte: ["$leaseUntil", "$$NOW"] }] },
] };

/**
 * Delivery is at least once: leases fence acknowledgments, not external effects.
 * The injected receiver must deduplicate producer/event ID and acknowledge only
 * durable history. No connection, timer, or database write is created on import.
 */
function createAuditWorker(db, producer, deliver, options = {}) {
  const names = outboxCollections(producer);
  if (typeof deliver !== "function") throw new TypeError("Audit worker requires a delivery function.");
  if (!options || Object.keys(options).some((key) => !Object.hasOwn(DEFAULTS, key))) throw new TypeError("Invalid audit worker options.");
  const config = { ...DEFAULTS, ...options };
  if (Object.values(config).some((value) => !Number.isSafeInteger(value) || value < 1) ||
      config.maxAttempts > 100 || config.leaseMs > 3600000 || config.retryMaxMs > 86400000 ||
      config.deliveryTimeoutMs >= config.leaseMs || config.retryBaseMs > config.retryMaxMs)
    throw new TypeError("Invalid audit worker limits.");
  const events = db.collection(names.events);
  let initialized = false;
  function requireInitialized() {
    if (!initialized) throw new Error("Audit worker must be initialized before use.");
  }

  async function claim() {
    // Select the earliest undelivered row of EACH stream before testing readiness.
    // Backoff, an active lease, or FAILED must block later rows only in that stream.
    // The unique stream/sequence index supports this ordering; project away PII
    // before grouping and permit disk spill for large numbers of resource streams.
    const candidates = await events.aggregate([
      { $match: { status: { $ne: "DELIVERED" } } },
      { $sort: { streamId: 1, "event.sequence": 1 } },
      { $project: { streamId: 1, status: 1, availableAt: 1, leaseUntil: 1, createdAt: 1, attempts: { $ifNull: ["$attempts", 0] } } },
      { $group: { _id: "$streamId", head: { $first: "$$ROOT" } } },
      { $replaceRoot: { newRoot: "$head" } },
      { $match: { $expr: ready } },
      { $sort: { availableAt: 1, createdAt: 1, _id: 1 } },
      { $limit: 32 },
    ], { readConcern: { level: "majority" }, readPreference: "primary", allowDiskUse: true, maxTimeMS: 5000 }).toArray();

    for (const candidate of candidates) {
      if (!Number.isSafeInteger(candidate.attempts) || candidate.attempts < 0) continue;
      const exhausted = candidate.attempts >= config.maxAttempts;
      const token = randomUUID();
      const row = await events.findOneAndUpdate({
        _id: candidate._id, status: candidate.status,
        $expr: { $and: [ready, { $eq: [{ $ifNull: ["$attempts", 0] }, candidate.attempts] }] },
      }, [{ $set: {
        status: "IN_FLIGHT", leaseToken: token, leaseUntil: { $add: ["$$NOW", config.leaseMs] },
        lastAttemptAt: "$$NOW", attempts: candidate.attempts + (exhausted ? 0 : 1),
        totalAttempts: { $add: [{ $ifNull: ["$totalAttempts", candidate.attempts] }, exhausted ? 0 : 1] },
      } }], { ...majority, returnDocument: "after" });
      // The atomic compare-and-set, rather than the aggregate snapshot, grants
      // ownership. Another worker can win, settle, or replay between these calls.
      if (row) return { row, token, exhausted };
    }
    return null;
  }

  async function send(event) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => deliver(event, { producer, signal: controller.signal })),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(Object.assign(new Error("Audit delivery timed out."), { code: "AUDIT_DELIVERY_TIMEOUT" }));
          }, config.deliveryTimeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
    // A transport that ignores abort can complete later. Never treat cancellation
    // as proof of no side effect; retrying the same event ID remains mandatory.
  }

  async function settle(claimed, result) {
    const { row, token } = claimed;
    const fields = { leaseToken: "$$REMOVE", leaseUntil: "$$REMOVE" };
    if (result.status === "DELIVERED") {
      Object.assign(fields, { status: "DELIVERED", deliveredAt: "$$NOW", auditId: result.auditId, lastErrorCode: "$$REMOVE" });
    } else {
      const terminal = result.permanent || row.attempts >= config.maxAttempts;
      result.status = terminal ? "FAILED" : "RETRY";
      Object.assign(fields, { status: terminal ? "FAILED" : "PENDING", lastErrorCode: result.code,
        lastFailureAt: "$$NOW",
        // A valid bounded receiver hint delays rather than bypasses durable
        // retry accounting. It may exceed the ordinary exponential-backoff cap.
        availableAt: { $add: ["$$NOW", Math.max(result.retryAfterMs || 0,
          Math.min(config.retryMaxMs, config.retryBaseMs * 2 ** (row.attempts - 1)))] },
        ...(terminal ? { failedAt: "$$NOW" } : {}),
      });
    }
    const updated = await events.updateOne({
      _id: row._id, status: "IN_FLIGHT", leaseToken: token, $expr: { $gt: ["$leaseUntil", "$$NOW"] },
    }, [{ $set: fields }], majority);
    // Expired or replaced tokens cannot acknowledge, reschedule, or fail a row.
    // Storage errors propagate: an unknown acknowledgment outcome needs recovery,
    // not a second update that might undo another worker's successful delivery.
    return { status: updated.matchedCount ? result.status : "LEASE_LOST", eventId: row._id,
      ...(updated.matchedCount && result.code ? { code: result.code } : {}),
    };
  }

  return {
    async initialize() {
      initialized = false;
      await createAuditOutbox(db, producer).initialize();
      initialized = true;
    },

    /** One bounded attempt; no network operation runs inside a MongoDB transaction. */
    async deliverNext() {
      requireInitialized();
      const claimed = await claim();
      if (!claimed) return { status: "IDLE" };
      if (claimed.exhausted) return settle(claimed, { permanent: true, code: "ATTEMPTS_EXHAUSTED" });
      let event;
      try {
        event = validateAuditEnvelope(claimed.row.event);
        if (event.producer !== producer || event.eventId !== claimed.row._id ||
            claimed.row.streamId !== `${event.resource.type}:${event.resource.id || event.eventId}`)
          throw new TypeError("Invalid outbox delivery identity.");
      } catch {
        return settle(claimed, { permanent: true, code: "INVALID_EVENT" });
      }
      let result;
      try {
        const acknowledgment = await send(event);
        if (!acknowledgment || typeof acknowledgment.auditId !== "string" || !/^[a-f\d]{24}$/.test(acknowledgment.auditId) ||
            typeof acknowledgment.duplicate !== "boolean")
          result = { code: "INVALID_ACKNOWLEDGMENT" };
        else result = { status: "DELIVERED", auditId: acknowledgment.auditId };
      } catch (error) {
        const codes = { AUDIT_DELIVERY_CONFLICT: "DELIVERY_CONFLICT", AUDIT_DELIVERY_TIMEOUT: "DELIVERY_TIMEOUT",
          AUDIT_INVALID_ACKNOWLEDGMENT: "INVALID_ACKNOWLEDGMENT", AUDIT_DELIVERY_UNAUTHORIZED: "DELIVERY_UNAUTHORIZED",
          AUDIT_DELIVERY_RATE_LIMITED: "DELIVERY_RATE_LIMITED" };
        result = { permanent: error?.code === "AUDIT_DELIVERY_CONFLICT",
          code: Object.hasOwn(codes, error?.code) ? codes[error.code] : "DELIVERY_FAILED" };
        if (Number.isSafeInteger(error?.retryAfterMs) && error.retryAfterMs > 0 &&
            ["AUDIT_DELIVERY_RATE_LIMITED", "AUDIT_DELIVERY_FAILED"].includes(error.code))
          result.retryAfterMs = Math.min(error.retryAfterMs, MAX_RETRY_AFTER_MS);
      }
      // Persist only allowlisted error codes. Exception messages can contain
      // credentials, request content, or database URIs and must not enter history.
      return settle(claimed, result);
    },

    /** Explicitly retry a FAILED head; never reset an active lease or delivered row. */
    async replay(eventId) {
      requireInitialized();
      if (typeof eventId !== "string" || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(eventId))
        throw new TypeError("Replay requires a UUIDv4 event ID.");
      const result = await events.updateOne({ _id: eventId.toLowerCase(), status: "FAILED" }, [{ $set: {
        status: "PENDING", attempts: 0, availableAt: "$$NOW", replayedAt: "$$NOW",
        replayCount: { $add: [{ $ifNull: ["$replayCount", 0] }, 1] },
      } }], majority);
      // Preserve payload, lifetime attempt count, and last failure for investigation.
      return { replayed: result.matchedCount === 1 };
    },
  };
}

module.exports = { createAuditWorker };
