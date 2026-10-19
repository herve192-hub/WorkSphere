/** Public identity boundary. Other domains receive authentication behavior, never account models. */
module.exports = {
  ...require("./authentication"),
  async initialize() {
    await Promise.all([require("./Account").init(), require("./Session").init(), require("./rateLimitStore").initialize()]);
  },
  // Lazy route loading avoids a cycle while identity records events through the audit boundary.
  get router() { return require("./routes"); },
};
