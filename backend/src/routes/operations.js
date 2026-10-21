const router = require("express").Router();
const mongoose = require("mongoose");
const { rateLimit } = require("express-rate-limit");
const { authenticate, allow } = require("../modules/identity");
const { getAuditDeliveryStatus } = require("../outbox");
const { MongoRateLimitStore } = require("../services/rateLimitStore");

const auditRateLimiter = rateLimit({
  // Share one IP budget across replicas without consuming register/login attempts.
  store: new MongoRateLimitStore("operations:audit:"),
  passOnStoreError: false,
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many audit health requests. Please try again later." } },
});

// Producer coordination belongs to platform operations, not Audit's history
// service. Keep aggregate delivery health restricted to administrators.
// Count every outcome before session lookups and aggregates; store failures stop
// the request too, so losing the limiter cannot expose unbounded database work.
router.get("/audit", auditRateLimiter, authenticate, allow("ADMIN"), async (_req, res) => {
  const result = await getAuditDeliveryStatus(mongoose.connection.db);
  res.set("Cache-Control", "no-store").status(result.status === "UP" ? 200 : 503).json(result);
});

module.exports = router;
