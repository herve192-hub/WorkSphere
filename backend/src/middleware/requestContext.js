const { randomUUID } = require("node:crypto");

module.exports = function requestContext(req, res, next) {
  const incoming = req.get("x-request-id");
  const requestId =
    typeof incoming === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming)
      ? incoming
      : randomUUID();

  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
};
