const logger = require("../utils/logger");

module.exports = function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info("http_request", {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      userId: req.user?.sub,
    });
  });

  next();
};
