const http = require("node:http");
const mongoose = require("mongoose");
const env = require("./src/config/env");
const app = require("./src/app");
const logger = require("./src/utils/logger");

let server;
let shuttingDown = false;

async function start() {
  await mongoose.connect(env.mongoUri);
  await Promise.all([
    require("./src/models/Account").init(),
    require("./src/models/Session").init(),
    require("./src/models/Employee").init(),
  ]);

  server = http.createServer(app);
  server.listen(env.port, () => {
    logger.info("api_started", { port: Number(env.port), environment: process.env.NODE_ENV || "development" });
  });
}

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

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled_rejection", { reason: reason instanceof Error ? reason.message : String(reason) });
});

process.on("uncaughtException", (error) => {
  logger.error("uncaught_exception", { errorMessage: error.message, stack: error.stack });
  shutdown("uncaughtException");
});

start().catch((error) => {
  logger.error("startup_failed", { errorMessage: error.message });
  process.exit(1);
});
