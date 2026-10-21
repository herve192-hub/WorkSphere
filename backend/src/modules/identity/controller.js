const bcrypt = require("bcryptjs");
const Account = require("./Account");
const Session = require("./Session");
const validation = require("../../services/validation");
const { prepare, issue, hash, clear, publicUser } = require("./sessions");
const { recordAuthEvent } = require("./audit");
const { withDomainTransaction } = require("../../services/transaction");

// Keeps unknown-account password checks comparable to valid-account checks.
const dummyHash = bcrypt.hashSync("unused-comparison-password", 12);

/**
 * Returns a standard 401 response for a failed login attempt.
 *
 * @param {import("express").Request} req - The current HTTP request.
 * @param {import("express").Response} res - The HTTP response object.
 * @returns {Promise<import("express").Response>} The failed-login response.
 */
async function incorrectLogin(req, res) {
  // No verified actor or business write, but intent and immediate history still
  // commit together. Storage failure must not leave only one of the two records.
  await withDomainTransaction((session) => recordAuthEvent(req, "AUTH_LOGIN_FAILED", null, session));
  return res.status(401).json({ error: { message: "Email or password is incorrect." } });
}

/**
 * Registers a new employee account.
 *
 * @param {import("express").Request} req - The HTTP request with profile details.
 * @param {import("express").Response} res - The HTTP response.
 * @returns {Promise<void>}
 */
exports.register = async (req, res) => {
  const data = validation.profile(req.body);
  const passwordHash = await bcrypt.hash(validation.password(req.body.password), 12);
  const user = await withDomainTransaction(async (session) => {
    const [account] = await Account.create([{ ...data, passwordHash, role: "EMPLOYEE" }], { session });
    await recordAuthEvent(req, "AUTH_REGISTERED", account, session);
    return account;
  });
  res.status(201).json({ data: publicUser(user) });
};

/**
 * Authenticates an account and issues a session token.
 *
 * @param {import("express").Request} req - The request containing email and password.
 * @param {import("express").Response} res - The HTTP response.
 * @returns {Promise<void>}
 */
exports.login = async (req, res) => {
  const { email, password } = req.body || {};
  if (
    typeof email !== "string" ||
    email.length > 254 ||
    typeof password !== "string" ||
    Buffer.byteLength(password) > 72
  ) {
    return incorrectLogin(req, res);
  }

  const user = await Account.findOne({ email: email.trim().toLowerCase() }).select("+passwordHash");
  const valid = await bcrypt.compare(password, user ? user.passwordHash : dummyHash);
  if (!user || !valid)
    return incorrectLogin(req, res);

  const prepared = await withDomainTransaction(async (session) => {
    const result = await prepare(user, session);
    await recordAuthEvent(req, "AUTH_LOGIN", user, session);
    return result;
  });
  res.json({ data: issue(res, prepared) });
};

/**
 * Refreshes an existing session using the refresh token cookie.
 *
 * @param {import("express").Request} req - The request containing the refresh token cookie.
 * @param {import("express").Response} res - The HTTP response.
 * @returns {Promise<void>}
 */
exports.refresh = async (req, res) => {
  const token = req.cookies.ws_refresh;
  const prepared = token && await withDomainTransaction(async (dbSession) => {
    const previous = await Session.findOneAndDelete({
      tokenHash: hash(token), expiresAt: { $gt: new Date() },
    }, { session: dbSession });
    const user = previous && await Account.findById(previous.account).session(dbSession);
    if (!user) return null;
    const result = await prepare(user, dbSession);
    await recordAuthEvent(req, "AUTH_REFRESHED", user, dbSession);
    return result;
  });

  if (!prepared) {
    clear(res);
    return res.status(401).json({
      error: { message: "Your session expired. Please sign in again." },
    });
  }

  res.json({ data: issue(res, prepared) });
};

/**
 * Invalidates the current refresh token and clears the session cookie.
 *
 * @param {import("express").Request} req - The request containing the refresh token cookie.
 * @param {import("express").Response} res - The HTTP response.
 * @returns {Promise<void>}
 */
exports.logout = async (req, res) => {
  if (req.cookies.ws_refresh) {
    await withDomainTransaction(async (session) => {
      const previous = await Session.findOneAndDelete({ tokenHash: hash(req.cookies.ws_refresh) }, { session });
      const user = previous && await Account.findById(previous.account).session(session);
      if (user) await recordAuthEvent(req, "AUTH_LOGOUT", user, session);
    });
  }
  clear(res);
  res.sendStatus(204);
};

/**
 * Returns the currently authenticated account profile.
 *
 * @param {import("express").Request} req - The request containing the authenticated user.
 * @param {import("express").Response} res - The HTTP response.
 * @returns {void}
 */
exports.me = (req, res) => res.json({ data: publicUser(req.user) });
