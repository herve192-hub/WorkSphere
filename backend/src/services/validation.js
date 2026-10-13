/**
 * Shared request validation helpers used by the API.
 * These functions normalize and validate user-supplied values before
 * persisting or authenticating them.
 */
const { normalizeNameInput } = require("./names");

/**
 * Validates and normalizes a profile payload.
 *
 * @param {Object} [body={}] The incoming profile data.
 * @returns {{ firstName: string, lastName: string, email: string }}
 *   A cleaned profile object with trimmed names and a lowercase email.
 * @throws {Error} When name or email values are missing or invalid.
 */
function profile(body = {}) {
  const { firstName, lastName, email } = normalizeNameInput(body || {});
  if (
    ![firstName, lastName, email].every((v) => typeof v === "string") ||
    !firstName.trim() ||
    !lastName.trim() ||
    firstName.trim().length > 80 ||
    lastName.trim().length > 80 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  ) {
    throw Object.assign(
      new Error("Enter your first name, last name, and a valid email address."),
      { status: 400 },
    );
  }
  return {
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    email: email.trim().toLowerCase(),
  };
}

/**
 * Validates a password value.
 *
 * @param {string} value The password to validate.
 * @returns {string} The original password value if it passes validation.
 * @throws {Error} When the password does not meet the length requirements.
 */
function password(value) {
  if (
    typeof value !== "string" ||
    value.length < 12 ||
    Buffer.byteLength(value, "utf8") > 72
  )
    throw Object.assign(
      new Error(
        "Use a password with at least 12 characters and no more than 72 UTF-8 bytes.",
      ),
      { status: 400 },
    );
  return value;
}
module.exports = { profile, password };
