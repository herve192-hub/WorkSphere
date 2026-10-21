const { randomUUID } = require("node:crypto");
const { outboxCollections } = require("./storage");
const { auditDeliveryMode, VISIBILITY_TARGET_MS, HEARTBEAT_STALE_MS } = require("./policy");

const workerCollection = (producer) => outboxCollections(producer).events.replace(/_outbox$/, "_workers");

/** Anonymous process presence; TTL removes only disposable heartbeat metadata. */
function createAuditHeartbeat(db, producer) {
  const workers = db.collection(workerCollection(producer));
  const id = randomUUID();
  let initialized = false;
  return {
    async initialize() {
      initialized = false;
      try { await db.createCollection(workers.collectionName); }
      catch (error) { if (error.code !== 48) throw error; }
      // Expiration is housekeeping, never the health decision. Staleness is
      // checked against server time even before MongoDB's TTL monitor runs.
      await workers.createIndex({ seenAt: 1 }, { name: "audit_worker_presence", expireAfterSeconds: 86400 });
      initialized = true;
    },
    async beat() {
      if (!initialized) throw new Error("Audit heartbeat must be initialized.");
      await workers.updateOne({ _id: id }, [{ $set: { status: "RUNNING", seenAt: "$$NOW" } }], { upsert: true, writeConcern: { w: "majority" } });
    },
    async stop() {
      if (!initialized) return;
      await workers.updateOne({ _id: id }, [{ $set: { status: "STOPPED", seenAt: "$$NOW" } }], { writeConcern: { w: "majority" } });
    },
  };
}

/** Read-only operational projection: never return event payloads, IDs, or raw errors. */
async function getAuditDeliveryStatus(db) {
  const producers = {};
  for (const producer of ["employees", "identity"]) {
    const options = { readConcern: { level: "majority" }, readPreference: "primary", maxTimeMS: 5000 };
    const [summary, presence] = await Promise.all([
      db.collection(outboxCollections(producer).events).aggregate([
        { $project: { status: 1, createdAt: 1, leaseUntil: 1, streamId: 1 } },
        { $facet: {
          counts: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
          oldest: [{ $match: { status: { $ne: "DELIVERED" } } }, { $group: { _id: null, createdAt: { $min: "$createdAt" } } },
            { $project: { _id: 0, ageMs: { $max: [0, { $subtract: ["$$NOW", "$createdAt"] }] } } }],
          blocked: [{ $match: { status: "FAILED" } }, { $group: { _id: "$streamId" } }, { $count: "count" }],
          expired: [{ $match: { status: "IN_FLIGHT", $expr: { $lte: ["$leaseUntil", "$$NOW"] } } }, { $count: "count" }],
        } },
      ], options).toArray(),
      db.collection(workerCollection(producer)).aggregate([
        { $match: { status: "RUNNING", $expr: { $gte: ["$seenAt", { $subtract: ["$$NOW", HEARTBEAT_STALE_MS] }] } } },
        { $count: "count" },
      ], options).toArray(),
    ]);
    const counts = Object.fromEntries((summary[0]?.counts || []).map((entry) => [entry._id, entry.count]));
    const report = {
      pending: counts.PENDING || 0, inFlight: counts.IN_FLIGHT || 0, failed: counts.FAILED || 0, delivered: counts.DELIVERED || 0,
      unknown: Object.entries(counts).filter(([state]) => !["PENDING", "IN_FLIGHT", "FAILED", "DELIVERED"].includes(state)).reduce((sum, [, count]) => sum + count, 0),
      blockedStreams: summary[0]?.blocked[0]?.count || 0, expiredLeases: summary[0]?.expired[0]?.count || 0,
      oldestOutstandingAgeMs: summary[0]?.oldest[0]?.ageMs || 0, activeWorkers: presence[0]?.count || 0,
    };
    report.status = report.failed || report.unknown || report.expiredLeases || report.oldestOutstandingAgeMs > VISIBILITY_TARGET_MS || !report.activeWorkers ? "DEGRADED" : "UP";
    producers[producer] = report;
  }
  return { status: Object.values(producers).every((report) => report.status === "UP") ? "UP" : "DEGRADED",
    mode: auditDeliveryMode(), visibilityTargetMs: VISIBILITY_TARGET_MS, producers };
}

module.exports = { createAuditHeartbeat, getAuditDeliveryStatus };
