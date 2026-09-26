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
