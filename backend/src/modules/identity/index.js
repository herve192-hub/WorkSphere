/** Public identity boundary. Other domains receive authentication behavior, never account models. */
module.exports = {
  ...require("./authentication"),
  async initialize() {
    // Auth and operations use the same TTL-indexed collection with separate budgets.
    await Promise.all([require("./Account").init(), require("./Session").init(), require("../../services/rateLimitStore").initialize()]);
    // Failed logins also enqueue, so initialize before exposing auth routes.
    await require("./audit").initialize();
  },
  // Lazy route loading avoids a cycle while identity records events through the audit boundary.
  get router() { return require("./routes"); },
};
