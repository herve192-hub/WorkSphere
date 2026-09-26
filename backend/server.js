/**
 * Starts the WorkSphere API server and initializes the required database models.
 *
 * @module server
 */
const mongoose = require("mongoose");
const env = require("./src/config/env");
const app = require("./src/app");

/**
 * Connects to MongoDB, initializes the application models, and starts listening
 * for incoming HTTP requests.
 *
 * @returns {Promise<void>} Resolves when the server is running.
 */
async function start() {
  await mongoose.connect(env.mongoUri);
  await require("./src/models/Account").init();
  await require("./src/models/Session").init();
  app.listen(env.port, () =>
    console.log(`WorkSphere API listening on port ${env.port}`),
  );
}
start().catch(() => {
  console.error(
    "API startup failed. Check database connectivity and configuration.",
  );
  process.exit(1);
});
