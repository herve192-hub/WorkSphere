const { createHash } = require("node:crypto");
const mongoose = require("mongoose");

// TTL cleanup is housekeeping. Expiration is also checked on each increment,
// because MongoDB's TTL monitor does not remove expired documents immediately.
// Retain the original model/collection so rolling upgrades share existing budgets.
const RateLimit = mongoose.model("AuthRateLimit", new mongoose.Schema({
  _id: String,
  totalHits: Number,
  resetTime: { type: Date, expires: 0 },
}, { versionKey: false }));

/** Shared MongoDB request budgets; each limiter must use its own stable namespace. */
class MongoRateLimitStore {
  constructor(prefix, collection = RateLimit.collection) {
    if (typeof prefix !== "string" || !/^[a-z][a-z0-9:-]*:$/.test(prefix)) {
      throw new TypeError("A stable rate-limit namespace ending in ':' is required.");
    }
    this.localKeys = false;
    this.prefix = prefix;
    // Standalone services bind their own native collection; the API retains its
    // existing model/collection and budgets when no explicit store is supplied.
    this.collection = collection;
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
      record = await this.collection.findOneAndUpdate({ _id: this.key(key) }, update, { upsert: true, returnDocument: "after" });
    } catch (error) {
      // A simultaneous first request can insert the same key. Count this request too.
      if (error.code !== 11000) throw error;
      record = await this.collection.findOneAndUpdate({ _id: this.key(key) }, update, { returnDocument: "after", upsert: true });
    }
    return { totalHits: record.totalHits, resetTime: record.resetTime };
  }

  async decrement(key) {
    await this.collection.updateOne({ _id: this.key(key), resetTime: { $gt: new Date() } },
      [{ $set: { totalHits: { $max: [0, { $subtract: ["$totalHits", 1] }] } } }]);
  }

  async resetKey(key) { await this.collection.deleteOne({ _id: this.key(key) }); }
}

module.exports = { MongoRateLimitStore, initialize: () => RateLimit.init() };
