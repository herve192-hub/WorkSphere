
/**
 * Load environment variables from a local .env file.
 * This keeps runtime configuration centralized and easy to inspect.
 */
require("dotenv").config();

/**
 * JWT secret used to sign and verify access tokens.
 * @type {string | undefined}
 */
const secret = process.env.JWT_ACCESS_SECRET;

if (!secret || secret.length < 32)
  throw new Error("JWT_ACCESS_SECRET must contain at least 32 characters");

/**
 * Application configuration values exposed to the rest of the backend.
 * @typedef {Object} AppConfig
 * @property {string} secret JWT access secret.
 * @property {boolean} production Whether the app is running in production mode.
 * @property {string} origin Allowed client origin for CORS.
 * @property {string} mongoUri MongoDB connection string.
 * @property {number|string} port HTTP server port.
 */

module.exports = {
  secret,
  production: process.env.NODE_ENV === "production",
  origin: process.env.CLIENT_ORIGIN || "http://localhost:3000",
  mongoUri: process.env.MONGO_URI || "mongodb://127.0.0.1:27017/worksphere",
  port: process.env.PORT || 5000,
};
