/**
 * Authentication routes.
 *
 * Provides endpoints for user registration, login, token refresh,
 * logout, and retrieving the authenticated user profile.
 */
const router = require("express").Router();
const { rateLimit } = require("express-rate-limit");
const controller = require("./controller");
const { authenticate } = require("./authentication");
const { MongoRateLimitStore } = require("./rateLimitStore");

// Prevent brute-force attempts on auth endpoints.

const limiter = rateLimit({
  // All replicas enforce the same budget; a database failure fails closed.
  store: new MongoRateLimitStore(),
  passOnStoreError: false,
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
