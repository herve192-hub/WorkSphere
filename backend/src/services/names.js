const AppError = require("../utils/AppError");

const NAME_FIELDS = [["firstName", "firstname"], ["lastName", "lastname"]];

// Accept cached clients during the transition, but never silently choose between
// two different values in a write request.
function normalizeNameInput(source) {
  const data = { ...source };
  for (const [canonical, legacy] of NAME_FIELDS) {
    const current = data[canonical];
    const previous = data[legacy];
    if (current !== undefined && previous !== undefined) {
      const clean = (value) => typeof value === "string" ? value.trim() : value;
      if (clean(current) !== clean(previous))
        throw new AppError(400, "VALIDATION_ERROR", `${canonical} and ${legacy} must match when both are provided.`);
    }
    if (current === undefined && previous !== undefined) data[canonical] = previous;
    delete data[legacy];
  }
  return data;
}

function resolvedNames(source) {
  return Object.fromEntries(NAME_FIELDS.map(([canonical, legacy]) =>
    [canonical, source[canonical] ?? source[legacy]],
  ));
}

// Response aliases keep already-loaded frontend bundles working during rollout.
function publicNames(source) {
  const names = resolvedNames(source);
  return { ...names, firstname: names.firstName, lastname: names.lastName };
}

// Use the same precedence for MongoDB sorting and the database migration.
const nameExpressions = Object.fromEntries(NAME_FIELDS.map(([canonical, legacy]) =>
  [canonical, { $ifNull: [`$${canonical}`, `$${legacy}`] }],
));

function addNameFields(schema) {
  for (const [canonical, legacy] of NAME_FIELDS) {
    schema.add({
      [canonical]: { type: String, required: true, trim: true, maxlength: 80 },
      // Existing documents can still be read before the migration runs.
      [legacy]: { type: String },
    });
  }
  schema.pre("validate", function () {
    for (const [canonical, legacy] of NAME_FIELDS) {
      if (this[canonical] == null && this[legacy] != null) this[canonical] = this[legacy];
      this[legacy] = undefined;
    }
  });
}

module.exports = { NAME_FIELDS, normalizeNameInput, resolvedNames, publicNames, nameExpressions, addNameFields };
