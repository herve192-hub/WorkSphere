class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

module.exports = AppError;
