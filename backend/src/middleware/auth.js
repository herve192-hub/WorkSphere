const jwt = require("jsonwebtoken");
const Account = require("../models/Account");
const Session = require("../models/Session");
const env = require("../config/env");

/**
 * Ensures the request carries a valid signed-in session.
 * It verifies the JWT from the `ws_access` cookie, checks the matching
 * database session is still active, loads the user account, and attaches
 * it to `req.user` before continuing the request.
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
  req.user = user;
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
