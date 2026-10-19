const jwt = require("jsonwebtoken");
const Account = require("./Account");
const Session = require("./Session");
const env = require("../../config/env");
const { publicNames } = require("../../services/names");

/**
 * Ensures the request carries a valid signed-in session.
 * It verifies the JWT from the `ws_access` cookie, checks the matching
 * database session is still active, loads the account, and attaches its public
 * identity snapshot to `req.user` before continuing the request.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
async function authenticate(req, res, next) {
  let payload;
  try {
    payload = jwt.verify(req.cookies.ws_access || "", env.secret, {
      algorithms: ["HS256"],
      issuer: "worksphere",
      audience: "worksphere-web",
    });
  } catch {
    return res
      .status(401)
      .json({ error: { message: "Please sign in to continue." } });
  }
  const session = await Session.findOne({
    _id: payload.sid,
    account: payload.sub,
    expiresAt: { $gt: new Date() },
  });
  const user = session && (await Account.findById(payload.sub));
  if (!user)
    return res
      .status(401)
      .json({ error: { message: "Please sign in to continue." } });
  // Pass a plain identity snapshot across domain boundaries, never an Account
  // document with persistence methods or sensitive session/account properties.
  req.user = { _id: user._id, id: user.id, ...publicNames(user), email: user.email, role: user.role };
  next();
}

/**
 * Builds a middleware that authorizes requests for one or more roles.
 *
 * @param {...string} roles
 * @returns {(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => void}
 */
const allow =
  (...roles) =>
  (req, res, next) =>
    roles.includes(req.user.role)
      ? next()
      : res
          .status(403)
          .json({
            error: {
              message: "You do not have permission to perform this action.",
            },
          });
module.exports = { authenticate, allow };
