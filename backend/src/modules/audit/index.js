/** Public audit boundary. Callers submit safe events and queries without accessing audit collections. */
module.exports = {
  ...require("./service"),
  async initialize() { await require("./AuditEvent").init(); },
  get router() { return require("./routes"); },
};
