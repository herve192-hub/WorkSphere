const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const env = require("./config/env");
const requestContext = require("./middleware/requestContext");
const requestLogger = require("./middleware/requestLogger");

const app = express();

app.disable("x-powered-by");
app.use(requestContext);
app.use(requestLogger);
app.use(helmet());
app.use(cors({ origin: env.origin, credentials: true }));
app.use(express.json({ limit: "16kb" }));
app.use(cookieParser());

// Cookie-authenticated mutations must originate from the configured web client.
app.use("/api", (req, res, next) => {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.get("origin") !== env.origin
  ) {
    return res.status(403).json({
      error: { code: "ORIGIN_NOT_ALLOWED", message: "Request origin is not allowed." },
      requestId: req.requestId,
    });
  }
  next();
});

// Liveness answers whether the Node process can serve HTTP.
app.get("/health/live", (_req, res) =>
  res.json({ status: "UP", service: "worksphere-api" }),
);

// Readiness additionally requires an active MongoDB connection.
app.get("/health/ready", (_req, res) => {
  const ready = mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({
    status: ready ? "UP" : "DOWN",
    service: "worksphere-api",
    dependencies: { mongodb: ready ? "UP" : "DOWN" },
  });
});

// Backward-compatible health endpoint; infrastructure should prefer /health/ready.
app.get("/health", (_req, res) => res.json({ status: "UP", service: "worksphere-api" }));

app.use("/api/v1/auth", require("./routes/auth"));
app.use("/api/v1/employees", require("./routes/employees"));
app.use(require("./middleware/notFound"));
app.use(require("./middleware/errorHandler"));

module.exports = app;
