const logger = require("../utils/logger");

module.exports = function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  let status =
    Number.isInteger(err.status) && err.status >= 400 && err.status <= 599
      ? err.status
      : 500;
  let code = typeof err.code === "string" ? err.code : "INTERNAL_SERVER_ERROR";
  let message = err.message;

  if (err.code === 11000) {
    status = 409;
    code = "DUPLICATE_RESOURCE";
    message = "A resource with that unique value already exists.";
  } else if (err.name === "ValidationError" || err.name === "CastError") {
    status = 400;
    code = "VALIDATION_ERROR";
    message = "One or more fields are invalid.";
  } else if (err.type === "entity.parse.failed") {
    status = 400;
    code = "INVALID_JSON";
    message = "Request body must contain valid JSON.";
  } else if (err.type === "entity.too.large") {
    status = 413;
    code = "PAYLOAD_TOO_LARGE";
    message = "Request body exceeds the size limit.";
  } else if (status < 500 && code === "INTERNAL_SERVER_ERROR") {
    code = "VALIDATION_ERROR";
  }

  if (status >= 500) {
    logger.error("request_failed", {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      errorName: err.name,
      errorMessage: err.message,
      stack: process.env.NODE_ENV === "production" ? undefined : err.stack,
    });
    code = "INTERNAL_SERVER_ERROR";
    message = "Something went wrong. Please try again.";
  }

  const error = { code, message };
  if (err.details && status < 500) error.details = err.details;

  const body = { error };
  if (req.requestId) body.requestId = req.requestId;
  res.status(status).json(body);
};
