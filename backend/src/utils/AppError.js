/**
 * Custom application error type used across the backend.
 *
 * Includes an HTTP status, an application-specific error code, and optional
 * structured details for API consumers and logging.
 */
class AppError extends Error {
  /**
   * Create a new AppError instance.
   *
   * @param {number} status - HTTP status code for the error.
   * @param {string} code - Application-specific error code.
   * @param {string} message - Human-readable error message.
   * @param {object} [details] - Optional structured error details.
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

module.exports = AppError;
