// An independent process and MongoDB connection are essential: two Express apps
// in one process would share the old in-memory hierarchy lock and hide the race.
const mongoose = require("mongoose");
const app = require("../../src/app");
let server;

async function start() {
  await mongoose.connect(process.env.MONGO_URI);
  await Promise.all(["identity", "employees", "audit"].map((domain) => require(`../../src/modules/${domain}`).initialize()));
  server = app.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));
}

process.on("message", async (message) => {
  if (message !== "close") return;
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  process.exit(0);
});
start().catch((error) => { console.error(error); process.exit(1); });
