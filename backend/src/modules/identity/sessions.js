const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const Session = require("./Session");
const env = require("../../config/env");
const { publicNames } = require("../../services/names");

/**
 * Hashes a value using SHA-256.
 *
 * @param {string} value - Plain-text value to hash.
 * @returns {string} Hex-encoded digest.
 */
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

const cookieOptions = {
  httpOnly: true,
  secure: env.production,
  sameSite: "strict",
  path: "/api/v1",
};

/**
 * Returns the subset of user data that can be exposed to a client.
 *
 * @param {object} user - User record from the database.
 * @returns {{ id: string, firstName?: string, lastName?: string, email: string, role: string }}
 */
const publicUser = (user) => ({
  id: user.id,
  ...publicNames(user),
  email: user.email,
  role: user.role,
});

/**
 * Creates a secure session payload for a user.
 *
 * A refresh token is generated, stored in the database with a hash, and
 * a short-lived access token is signed for API authentication.
 *
 * @param {object} user - Authenticated user document.
 * @param {import("mongoose").ClientSession} [dbSession] - Transaction session for DB writes.
 * @returns {Promise<{ access: string, token: string, user: object }>} Session credentials and public user profile.
 */
async function prepare(user, dbSession) {
  const token = crypto.randomBytes(32).toString("hex");
  const [session] = await Session.create([{
    account: user._id,
    tokenHash: hash(token),
    expiresAt: new Date(Date.now() + 7 * 86400000),
  }], { session: dbSession });
  const access = jwt.sign({ sid: session.id }, env.secret, {
    subject: user.id,
    expiresIn: "15m",
    issuer: "worksphere",
    audience: "worksphere-web",
    algorithm: "HS256",
  });
  return { access, token, user: publicUser(user) };
}

/**
 * Writes the session cookies to an HTTP response.
 *
 * @param {object} res - Express response object.
 * @param {{ access: string, token: string, user: object }} prepared - Prepared session data.
 * @returns {{ id: string, firstName?: string, lastName?: string, email: string, role: string }}
 */
function issue(res, prepared) {
  res.cookie("ws_access", prepared.access, { ...cookieOptions, maxAge: 900000 });
  res.cookie("ws_refresh", prepared.token, { ...cookieOptions, maxAge: 7 * 86400000 });
  return prepared.user;
}

/**
 * Clears the session cookies from the client.
 *
 * @param {object} res - Express response object.
 */
function clear(res) {
  res.clearCookie("ws_access", cookieOptions);
  res.clearCookie("ws_refresh", cookieOptions);
}

module.exports = { hash, prepare, issue, clear, publicUser };
