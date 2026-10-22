const usage = "Usage: node scripts/audit-worker.js [--once | --help]";

/** Run separately from the API so receiver outages cannot roll back business writes. */
async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  if (args.length > 1 || (args.length && args[0] !== "--once")) throw new Error(usage);
  const once = args.includes("--once");
  require("dotenv").config();
  const { createAuditWorker, createAuditHeartbeat } = require("../src/outbox");
  const { HEARTBEAT_INTERVAL_MS } = require("../src/outbox/policy");
  const { createAuditHttpDelivery } = require("../src/outbox/httpDelivery");
  const { loadAuditWorkerConfig } = require("../src/outbox/workerConfig");
  const { connectAuditDatabase } = require("../src/outbox/connection");
  const config = loadAuditWorkerConfig();
  const deliveries = {};
  if (config.transport === "http") {
    for (const producer of ["employees", "identity"])
      deliveries[producer] = createAuditHttpDelivery({ url: config.url, producer, key: config.keys[producer] });
  }
  let stopped = false, wake, forceExit, connection, heartbeatTimer, pulse;
  const heartbeats = [];
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
    if (config.transport === "local") {
      // The compatibility path alone opens local history. Remote outages must
      // retain producer intent, never create a second local Audit projection.
      const { createAuditConsumer } = require("../src/modules/audit");
      const receiver = createAuditConsumer(connection.db);
      await receiver.initialize();
      for (const producer of ["employees", "identity"])
        deliveries[producer] = (event, context) => receiver.consume(event, context);
    }
    const workers = ["employees", "identity"].map((producer) => ({ producer,
      worker: createAuditWorker(connection.db, producer, deliveries[producer]),
    }));
    await Promise.all(workers.map(({ worker }) => worker.initialize()));
    for (const { producer } of workers) {
      const heartbeat = createAuditHeartbeat(connection.db, producer);
      await heartbeat.initialize();
      heartbeats.push(heartbeat);
    }
    const beat = async () => {
      for (const heartbeat of heartbeats) await heartbeat.beat();
    };
    await beat();
    // Presence is independent of receiver latency. Do not overlap heartbeat
    // writes or let a late beat resurrect this instance after graceful shutdown.
    heartbeatTimer = setInterval(() => {
      if (pulse) return;
      pulse = beat().catch(() => console.error(JSON.stringify({ code: "AUDIT_WORKER_HEARTBEAT_ERROR" }))).finally(() => { pulse = null; });
    }, HEARTBEAT_INTERVAL_MS);
    console.log(JSON.stringify({ status: "READY", transport: config.transport, producers: workers.map(({ producer }) => producer) }));
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
    clearInterval(heartbeatTimer);
    try {
      await pulse;
      for (const heartbeat of heartbeats) await heartbeat.stop();
    } finally {
      try { await connection?.client.close(); }
      finally {
        clearTimeout(forceExit);
        process.removeListener("SIGTERM", stop);
        process.removeListener("SIGINT", stop);
      }
    }
  }
}

if (require.main === module) main().catch(() => {
  console.error("Audit worker failed. Check database availability and worker configuration.");
  process.exitCode = 1;
});

module.exports = { main };
