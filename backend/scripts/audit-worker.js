const usage = "Usage: node scripts/audit-worker.js [--once | --help]";

/** Run separately from the API; immediate history remains enabled during this step. */
async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  if (args.length > 1 || (args.length && args[0] !== "--once")) throw new Error(usage);
  const once = args.includes("--once");
  require("dotenv").config();
  const { createAuditWorker } = require("../src/outbox");
  const { createAuditConsumer } = require("../src/modules/audit");
  const { connectAuditDatabase } = require("../src/outbox/connection");
  let stopped = false, wake, forceExit, connection;
  const stop = () => {
    stopped = true;
    wake?.();
    // A transport may ignore abort; hard termination leaves its fenced lease for
    // another process to recover, rather than pretending the event was delivered.
    forceExit ||= setTimeout(() => process.exit(1), 15000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    connection = await connectAuditDatabase(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/worksphere");
    const receiver = createAuditConsumer(connection.db);
    await receiver.initialize();
    const workers = ["employees", "identity"].map((producer) => ({ producer,
      worker: createAuditWorker(connection.db, producer, (event, context) => receiver.consume(event, context)),
    }));
    await Promise.all(workers.map(({ worker }) => worker.initialize()));
    console.log(JSON.stringify({ status: "READY", producers: workers.map(({ producer }) => producer) }));
    while (!stopped) {
      let idle = true;
      for (const { producer, worker } of workers) {
        if (stopped) break;
        try {
          const result = await worker.deliverNext();
          if (result.status !== "IDLE") {
            idle = false;
            console.log(JSON.stringify({ producer, ...result }));
            if (once && result.status !== "DELIVERED") process.exitCode = 1;
          }
        } catch {
          // Never log raw transport/database errors, which can embed credentials.
          console.error(JSON.stringify({ producer, code: "AUDIT_WORKER_STORAGE_ERROR" }));
          if (once) process.exitCode = 1;
        }
      }
      if (once || stopped) break;
      await new Promise((resolve) => {
        const timer = setTimeout(() => { wake = null; resolve(); }, idle ? 1000 : 0);
        wake = () => { clearTimeout(timer); wake = null; resolve(); };
      });
    }
  } finally {
    try { await connection?.client.close(); }
    finally {
      clearTimeout(forceExit);
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
    }
  }
}

if (require.main === module) main().catch(() => {
  console.error("Audit worker failed. Check database availability and worker configuration.");
  process.exitCode = 1;
});

module.exports = { main };
