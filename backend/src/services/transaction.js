const mongoose = require("mongoose");

/**
 * Acknowledge business state, audit intent, and immediate history only after a
 * majority commit. Mongoose retries transient conflicts with a fresh snapshot;
 * callbacks must keep external effects (including response cookies) after commit.
 */
function withDomainTransaction(operation) {
  return mongoose.connection.transaction(operation, {
    readConcern: { level: "snapshot" }, writeConcern: { w: "majority" },
  });
}

module.exports = { withDomainTransaction };
