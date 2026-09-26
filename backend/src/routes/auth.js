const router = require("express").Router();
const bcrypt = require("bcryptjs");
const { rateLimit } = require("express-rate-limit");
const Account = require("../models/Account");
const Session = require("../models/Session");
const validation = require("../services/validation");
const { issue, hash, clear, publicUser } = require("../services/sessions");
const { authenticate } = require("../middleware/auth");
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: { message: "Too many attempts. Please try again in 15 minutes." },
  },
});
// A real cost-12 hash keeps unknown-account checks comparable to password checks.
const dummyHash = bcrypt.hashSync("unused-comparison-password", 12);
router.post("/register", limiter, async (req, res) => {
  const data = validation.profile(req.body);
  const passwordHash = await bcrypt.hash(
    validation.password(req.body.password),
    12,
  );
  const user = await Account.create({
    ...data,
    passwordHash,
    role: "EMPLOYEE",
  });
  res.status(201).json({ data: publicUser(user) });
});
router.post("/login", limiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (
    typeof email !== "string" ||
    email.length > 254 ||
    typeof password !== "string" ||
    Buffer.byteLength(password) > 72
  )
    return res
      .status(401)
      .json({ error: { message: "Email or password is incorrect." } });
  const user = await Account.findOne({
    email: email.trim().toLowerCase(),
  }).select("+passwordHash");
  const valid = await bcrypt.compare(
    password,
    user ? user.passwordHash : dummyHash,
  );
  if (!user || !valid)
    return res
      .status(401)
      .json({ error: { message: "Email or password is incorrect." } });
  res.json({ data: await issue(res, user) });
});
router.post("/refresh", async (req, res) => {
  const token = req.cookies.ws_refresh;
  const session =
    token &&
    (await Session.findOneAndDelete({
      tokenHash: hash(token),
      expiresAt: { $gt: new Date() },
    }));
  const user = session && (await Account.findById(session.account));
  if (!user) {
    clear(res);
    return res.status(401).json({
      error: { message: "Your session expired. Please sign in again." },
    });
  }
  res.json({ data: await issue(res, user) });
});
router.post("/logout", async (req, res) => {
  if (req.cookies.ws_refresh)
    await Session.deleteOne({ tokenHash: hash(req.cookies.ws_refresh) });
  clear(res);
  res.sendStatus(204);
});
router.get("/me", authenticate, (req, res) =>
  res.json({ data: publicUser(req.user) }),
);
module.exports = router;
