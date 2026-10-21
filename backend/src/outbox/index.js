/** Producer-owned storage and delivery; Audit is reached only through an injected transport. */
module.exports = {
  createAuditOutbox: require("./storage").createAuditOutbox,
  ...require("./worker"),
};
