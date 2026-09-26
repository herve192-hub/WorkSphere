/**
 * Application bootstrap for WorkSphere.
 *
 * This file configures core HTTP middleware, enforces browser-origin checks
 * for mutating API requests, and mounts the auth and employee route groups.
 */
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const env = require("./config/env");

const app = express();

app.disable("x-powered-by");

// Security and request parsing middleware.
app.use(helmet());
app.use(cors({ origin: env.origin, credentials: true }));
app.use(express.json({ limit: "16kb" }));
app.use(cookieParser());

// Cookies authenticate requests: enforce the browser origin on every mutation.
app.use("/api", (req, res, next) => {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.get("origin") !== env.origin
  )
    return res
      .status(403)
      .json({ error: { message: "Request origin is not allowed." } });

  next();
});

// Health check endpoint for infrastructure monitoring.
app.get("/health", (_req, res) => res.json({ status: "UP" }));

// API route mounting.
app.use("/api/v1/auth", require("./routes/auth"));
app.use("/api/v1/employees", require("./routes/employees"));

// Not-found handler for unmatched routes.
app.use((_req, res) =>
  res.status(404).json({ error: { message: "Endpoint not found." } }),
);

// Centralized error handler for validation and persistence issues.
app.use((err, _req, res, _next) => {
  const status =
    err.code === 11000
      ? 409
      : err.status || (err.name === "ValidationError" ? 400 : 500);
  const message =
    err.code === 11000
      ? "This email is already in use."
      : status >= 500
        ? "Something went wrong. Please try again."
        : err.message;

  res.status(status).json({ error: { message } });
});

module.exports = app;
