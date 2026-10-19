const { createHash } = require("node:crypto");
const mongoose = require("mongoose");

// TTL cleanup is housekeeping. Expiration is also checked on each increment,
// because MongoDB's TTL monitor does not remove expired documents immediately.
const RateLimit = mongoose.model("AuthRateLimit", new mongoose.Schema({
  _id: String,
  totalHits: Number,
  resetTime: { type: Date, expires: 0 },
}, { versionKey: false }));

/** MongoDB-backed express-rate-limit store shared by every identity instance. */
class MongoRateLimitStore {
  constructor() {
    this.localKeys = false;
    this.prefix = "identity:auth:";
  }

  init(options) { this.windowMs = options.windowMs; }

  // Hash the IP-derived key so the limiter does not persist raw client addresses.
  key(value) { return this.prefix + createHash("sha256").update(value).digest("hex"); }

  async increment(key) {
    const active = { $gt: ["$resetTime", "$$NOW"] };
    const update = [{ $set: {
      totalHits: { $cond: [active, { $add: ["$totalHits", 1] }, 1] },
      resetTime: { $cond: [active, "$resetTime", { $add: ["$$NOW", this.windowMs] }] },
    } }];
    let record;
    try {
      record = await RateLimit.collection.findOneAndUpdate({ _id: this.key(key) }, update, { upsert: true, returnDocument: "after" });
    } catch (error) {
      // A simultaneous first request can insert the same key. Count this request too.
      if (error.code !== 11000) throw error;
      record = await RateLimit.collection.findOneAndUpdate({ _id: this.key(key) }, update, { returnDocument: "after", upsert: true });
    }
    return { totalHits: record.totalHits, resetTime: record.resetTime };
  }

  async decrement(key) {
    await RateLimit.collection.updateOne({ _id: this.key(key), resetTime: { $gt: new Date() } },
      [{ $set: { totalHits: { $max: [0, { $subtract: ["$totalHits", 1] }] } } }]);
  }

  async resetKey(key) { await RateLimit.deleteOne({ _id: this.key(key) }); }
}

module.exports = { MongoRateLimitStore, initialize: () => RateLimit.init() };
