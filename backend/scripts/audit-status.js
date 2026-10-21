const usage = "Usage: node scripts/audit-status.js [--check | --help]";

/** Read-only worker/backlog health for operators and container health checks. */
async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  if (args.length > 1 || (args.length && args[0] !== "--check")) throw new Error(usage);
  require("dotenv").config();
  const { connectAuditDatabase } = require("../src/outbox/connection");
  const { getAuditDeliveryStatus } = require("../src/outbox");
  const { client, db } = await connectAuditDatabase(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/worksphere");
  try {
    const status = await getAuditDeliveryStatus(db);
    console.log(JSON.stringify(status));
    if (args.includes("--check") && status.status !== "UP") process.exitCode = 1;
  } finally { await client.close(); }
}
if (require.main === module) main().catch(() => { console.error("Audit status unavailable. Check database availability."); process.exitCode = 1; });
module.exports = { main };
