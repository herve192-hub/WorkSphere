const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const Session = require("../models/Session");
const env = require("../config/env");
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const cookieOptions = {
  httpOnly: true,
  secure: env.production,
  sameSite: "strict",
  path: "/api/v1",
};
const publicUser = (user) => ({
  id: user.id,
  firstname: user.firstname,
  lastname: user.lastname,
  email: user.email,
  role: user.role,
});
async function issue(res, user) {
  const token = crypto.randomBytes(32).toString("hex");
  const session = await Session.create({
    account: user._id,
    tokenHash: hash(token),
    expiresAt: new Date(Date.now() + 7 * 86400000),
  });
  const access = jwt.sign({ sid: session.id }, env.secret, {
    subject: user.id,
    expiresIn: "15m",
    issuer: "worksphere",
    audience: "worksphere-web",
    algorithm: "HS256",
  });
  res.cookie("ws_access", access, { ...cookieOptions, maxAge: 900000 });
  res.cookie("ws_refresh", token, { ...cookieOptions, maxAge: 7 * 86400000 });
  return publicUser(user);
}
function clear(res) {
  res.clearCookie("ws_access", cookieOptions);
  res.clearCookie("ws_refresh", cookieOptions);
}
module.exports = { hash, issue, clear, publicUser };
