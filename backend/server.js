/**
 * Starts the HTTP API, verifies the MongoDB topology required for atomic audit history,
 * and installs graceful shutdown handlers for the process lifecycle.
 */
const http = require("node:http");
const mongoose = require("mongoose");
const env = require("./src/config/env");
const app = require("./src/app");
const logger = require("./src/utils/logger");

let server;
let shuttingDown = false;

/**
 * Connects to MongoDB, validates the cluster topology, initializes model metadata,
 * and starts the API server once all dependencies are ready.
 */
async function start() {
  await mongoose.connect(env.mongoUri);
  const topology = await mongoose.connection.db.admin().command({ hello: 1 });
  // Audit history relies on atomic operations that are only supported by replica sets or sharded clusters.
  if (!topology.setName && topology.msg !== "isdbgrid")
    throw new Error("MongoDB must be a replica set or sharded cluster for atomic audit history.");
  await Promise.all([
    require("./src/modules/identity").initialize(),
    require("./src/modules/employees").initialize(),
    require("./src/modules/audit").initialize(),
  ]);

  server = http.createServer(app);
  server.listen(env.port, () => {
    logger.info("api_started", { port: Number(env.port), environment: process.env.NODE_ENV || "development" });
  });
}

/**
 * Stops the HTTP server and closes the MongoDB connection in a controlled way.
 * A timeout forces the process to exit if shutdown hangs.
 *
 * @param {string} signal - The OS signal that triggered shutdown.
 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutdown_started", { signal });

  const forceExit = setTimeout(() => {
    logger.error("shutdown_forced", { signal });
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    if (server) {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await mongoose.disconnect();
    clearTimeout(forceExit);
    logger.info("shutdown_complete", { signal });
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExit);
    logger.error("shutdown_failed", { signal, errorMessage: error.message });
    process.exit(1);
  }
}

// Gracefully handle termination signals from the runtime or orchestrator.
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled_rejection", { reason: reason instanceof Error ? reason.message : String(reason) });
});

process.on("uncaughtException", (error) => {
  logger.error("uncaught_exception", { errorMessage: error.message, stack: error.stack });
  shutdown("uncaughtException");
});

// Launch the server and fail fast if startup prerequisites are not met.
start().catch((error) => {
  logger.error("startup_failed", { errorMessage: error.message });
  process.exit(1);
});
