/** Public employee boundary. Employee records, manager relationships, and number allocation stay together. */
module.exports = {
  // Maintenance commands allocate/backfill numbers without loading models or
  // triggering Mongoose index creation during a dry run. Load handlers on use.
  listEmployees: (...args) => require("./service").listEmployees(...args),
  getEmployee: (...args) => require("./service").getEmployee(...args),
  createEmployee: (...args) => require("./service").createEmployee(...args),
  updateEmployee: (...args) => require("./service").updateEmployee(...args),
  deleteEmployee: (...args) => require("./service").deleteEmployee(...args),
  ...require("./numbers"),
  async initialize() {
    await require("./Employee").init();
    // Await producer-owned indexes before any business transaction can enqueue.
    await require("./audit").initialize();
  },
  get router() { return require("./routes"); },
};
