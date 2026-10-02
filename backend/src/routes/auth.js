const router = require("express").Router();
const { rateLimit } = require("express-rate-limit");
const controller = require("../controllers/authController");
const { authenticate } = require("../middleware/auth");

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: { message: "Too many attempts. Please try again in 15 minutes." } },
});

router.post("/register", limiter, controller.register);
router.post("/login", limiter, controller.login);
router.post("/refresh", controller.refresh);
router.post("/logout", controller.logout);
router.get("/me", authenticate, controller.me);

module.exports = router;
