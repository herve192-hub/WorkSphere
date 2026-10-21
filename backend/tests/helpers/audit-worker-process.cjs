// A killed process cannot run finally blocks or release its lease. Exercise the
// same public worker/consumer contract used by the operational command.
const { connectAuditDatabase } = require("../../src/outbox/connection");
const { createAuditWorker } = require("../../src/outbox");
const { createAuditConsumer } = require("../../src/modules/audit");

async function start() {
  const { db } = await connectAuditDatabase(process.env.MONGO_URI);
  const receiver = createAuditConsumer(db);
  await receiver.initialize();
  const worker = createAuditWorker(db, "employees", async (event, context) => {
    const acknowledgment = process.env.CRASH_BOUNDARY === "after-delivery" ? await receiver.consume(event, context) : null;
    process.send({ claimed: event.eventId, auditId: acknowledgment?.auditId });
    return new Promise(() => {}); // Parent sends SIGKILL before acknowledgment.
  });
  await worker.initialize();
  await worker.deliverNext();
}

start().catch(() => { console.error("Fixture worker startup failed."); process.exit(1); });
