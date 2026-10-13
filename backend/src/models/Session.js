/**
 * Represents a persisted authentication session for an account.
 * The session stores a hash of the issued token and automatically expires
 * when the configured timestamp is reached.
 */
const mongoose = require("mongoose");

module.exports = mongoose.model(
  "Session",
  new mongoose.Schema(
    {
      account: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Account",
        required: true,
      },
      tokenHash: { type: String, required: true, unique: true },
      expiresAt: { type: Date, required: true, expires: 0 },
    },
    { timestamps: true },
  ),
);
