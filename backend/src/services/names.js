const AppError = require("../utils/AppError");

const NAME_FIELDS = [["firstName", "firstname"], ["lastName", "lastname"]];

/**
 * Normalizes a submitted name payload while the backend supports both the
 * canonical camelCase fields and their legacy lowercase aliases.
 *
 * If both the canonical and legacy values are present, they must match exactly
 * after trimming. When only the legacy field is present, it is copied into the
 * canonical field so downstream code can operate on a single schema.
 *
 * @param {Object} source - Raw request data that may contain either naming style.
 * @returns {Object} A copy of the input with legacy aliases removed.
 * @throws {AppError} When contradictory values are submitted for the same field.
 */
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

/**
 * Resolves each name field to the canonical property, falling back to the legacy
 * alias when the modern field has not yet been populated.
 *
 * @param {Object} source - Object that may contain either canonical or legacy keys.
 * @returns {Object} A map of canonical names to the resolved value.
 */
function resolvedNames(source) {
  return Object.fromEntries(NAME_FIELDS.map(([canonical, legacy]) =>
    [canonical, source[canonical] ?? source[legacy]],
  ));
}

/**
 * Returns a public-facing name payload that preserves compatibility with older
 * frontend clients still reading the legacy lowercase aliases.
 *
 * @param {Object} source - Document or request payload containing names.
 * @returns {Object} Canonical name fields plus compatibility aliases.
 */
function publicNames(source) {
  const names = resolvedNames(source);
  return { ...names, firstname: names.firstName, lastname: names.lastName };
}

/**
 * Mongo aggregation expressions used when sorting or projecting name values while
 * both the canonical and legacy fields may coexist during rollout.
 *
 * The canonical field wins when present; otherwise the legacy alias is used.
 */
const nameExpressions = Object.fromEntries(NAME_FIELDS.map(([canonical, legacy]) =>
  [canonical, { $ifNull: [`$${canonical}`, `$${legacy}`] }],
));

/**
 * Adds the canonical name fields and their temporary legacy aliases to a schema.
 *
 * During the migration window, validation copies the legacy value into the
 * canonical field when needed and removes the alias before persistence so the
 * database can be migrated to the new schema cleanly.
 *
 * @param {mongoose.Schema} schema - Mongoose schema to extend.
 */
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
