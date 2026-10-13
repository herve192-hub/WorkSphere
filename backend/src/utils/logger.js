/**
 * Lightweight JSON logger for backend application logs.
 * Each log entry is written as a single JSON line with a timestamp,
 * log level, message, and any extra context fields.
 */

/**
 * Writes a structured log entry to the console.
 * @param {"info" | "warn" | "error"} level Log severity level.
 * @param {string} message Human-readable message to log.
 * @param {Record<string, any>} [fields={}] Additional context to include in the entry.
 * @returns {void}
 */
function write(level, message, fields = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

module.exports = {
  /**
   * Logs informational output.
   * @param {string} message Human-readable message.
   * @param {Record<string, any>} [fields] Additional metadata to attach.
   */
  info: (message, fields) => write("info", message, fields),

  /**
   * Logs a warning message.
   * @param {string} message Human-readable message.
   * @param {Record<string, any>} [fields] Additional metadata to attach.
   */
  warn: (message, fields) => write("warn", message, fields),

  /**
   * Logs an error message.
   * @param {string} message Human-readable message.
   * @param {Record<string, any>} [fields] Additional metadata to attach.
   */
  error: (message, fields) => write("error", message, fields),
};
