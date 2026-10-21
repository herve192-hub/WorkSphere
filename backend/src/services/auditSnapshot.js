const { resolvedNames } = require("./names");

/** Project only verified, public identity fields, including legacy name fallback. */
function actorSnapshot(actor) {
  return actor ? { id: String(actor._id), ...resolvedNames(actor), email: actor.email, role: actor.role } : null;
}

module.exports = { actorSnapshot };
