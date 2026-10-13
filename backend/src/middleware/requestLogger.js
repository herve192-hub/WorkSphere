/**
 * Logs an HTTP request after the response finishes.
 *
 * Captures request metadata such as the request ID, HTTP method, route,
 * response status, duration, and authenticated user ID so that inbound
 * traffic can be monitored and debugged consistently.
 *
 * @param {import("express").Request} req - The incoming HTTP request.
 * @param {import("express").Response} res - The outgoing HTTP response.
 * @param {Function} next - The next middleware function.
 */
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
      userId: req.user?.id,
    });
  });

  next();
};
