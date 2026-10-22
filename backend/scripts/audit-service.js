const usage = "Usage: node scripts/audit-service.js [--help]";

/** Run Audit independently; configuration and failures never print credentials. */
async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  if (args.length) throw new Error(usage);
  require("dotenv").config();
  const { loadAuditServiceConfig } = require("../src/audit-service/config");
  const { startAuditService } = require("../src/audit-service/runtime");
  const logger = require("../src/utils/logger");
  const config = loadAuditServiceConfig();
  let forceExit, instance, resolveStop;
  const stopped = new Promise((resolve) => { resolveStop = resolve; });
  const stop = () => {
    forceExit ||= setTimeout(() => process.exit(1), 15000).unref();
    resolveStop();
  };
  const fatal = () => { process.exitCode = 1; logger.error("audit_service_fatal"); stop(); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
  try {
    instance = await startAuditService(config);
    logger.info("audit_service_ready", { host: config.host, port: instance.server.address().port });
    await stopped;
    await instance.close();
    logger.info("audit_service_stopped");
  } finally {
    clearTimeout(forceExit);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    process.removeListener("uncaughtException", fatal);
    process.removeListener("unhandledRejection", fatal);
  }
}

if (require.main === module) main().catch(() => {
  console.error("Audit service failed. Check Audit configuration and database availability.");
  process.exitCode = 1;
});
module.exports = { main };
