const router = require("express").Router();
const mongoose = require("mongoose");
const { authenticate, allow } = require("../modules/identity");
const { getAuditDeliveryStatus } = require("../outbox");

// Producer coordination belongs to platform operations, not Audit's history
// service. Keep aggregate delivery health restricted to administrators.
router.get("/audit", authenticate, allow("ADMIN"), async (_req, res) => {
  const result = await getAuditDeliveryStatus(mongoose.connection.db);
  res.set("Cache-Control", "no-store").status(result.status === "UP" ? 200 : 503).json(result);
});

module.exports = router;
