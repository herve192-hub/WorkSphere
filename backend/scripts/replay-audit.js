const usage = "Usage: node scripts/replay-audit.js --producer <employees|identity> --event-id <UUIDv4> --apply";

/** Explicit operator action: reset one FAILED event, preserving its immutable envelope. */
async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!["--producer", "--event-id", "--apply"].includes(key) || Object.hasOwn(options, key)) throw new Error(usage);
    options[key] = key === "--apply" ? true : args[++index];
  }
  if (!options["--apply"] || !["employees", "identity"].includes(options["--producer"]) ||
      typeof options["--event-id"] !== "string" || !/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(options["--event-id"]))
    throw new Error(usage);
  require("dotenv").config();
  const { createAuditWorker } = require("../src/outbox");
  const { connectAuditDatabase } = require("../src/outbox/connection");
  const connection = await connectAuditDatabase(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/worksphere");
  try {
    const producer = options["--producer"];
    const worker = createAuditWorker(connection.db, producer, async () => { throw new Error("Replay does not deliver events."); });
    await worker.initialize();
    const result = await worker.replay(options["--event-id"]);
    console.log(JSON.stringify({ producer, eventId: options["--event-id"].toLowerCase(), ...result }));
    if (!result.replayed) process.exitCode = 1;
  } finally { await connection.client.close(); }
}

if (require.main === module) main().catch(() => {
  console.error(usage);
  console.error("Replay failed; check the command, database availability, and event status.");
  process.exitCode = 1;
});

module.exports = { main };
