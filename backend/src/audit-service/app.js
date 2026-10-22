const express = require("express");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const { createAuditConsumer, createAuditReader } = require("../modules/audit");
const { validateAuditEnvelope, MAX_AUDIT_EVENT_BYTES } = require("../contracts/auditEvent");
const { MongoRateLimitStore } = require("../services/rateLimitStore");
const requestContext = require("../middleware/requestContext");
const AppError = require("../utils/AppError");
const logger = require("../utils/logger");
const { validateServiceKeys } = require("./config");
const { serviceAuthentication, allowIngestion, allowQueries } = require("./authentication");

const RATE_LIMIT_COLLECTION = "audit_request_budgets";

/** Private HTTP transport on an explicit Db; construction performs no database writes. */
function createAuditService({ db, keys }) {
  const trustedKeys = validateServiceKeys(keys);
  const consumer = createAuditConsumer(db), reader = createAuditReader(db);
  const budgets = db.collection(RATE_LIMIT_COLLECTION);
  const app = express();
  let initialized = false, draining = false;
  app.disable("x-powered-by");
  app.use(helmet(), requestContext);
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => logger.info("audit_http_request", {
      requestId: req.requestId, method: req.method, operation: req.route?.path || "unmatched",
      statusCode: res.statusCode, durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      client: req.auditCaller?.subject,
    })); // Never log raw URLs, query values, bodies, tokens, or database errors.
    next();
  });

  function limiter(prefix, limit, keyGenerator) {
    return rateLimit({
      store: new MongoRateLimitStore(prefix, budgets), windowMs: 60000, limit,
      ...(keyGenerator ? { keyGenerator } : {}), passOnStoreError: false,
      standardHeaders: "draft-7", legacyHeaders: false,
      message: { error: { code: "RATE_LIMIT_EXCEEDED", message: "Audit request budget exhausted. Honor Retry-After." } },
    });
  }
  // Shared ingress accounting protects authentication and parsing. Each trusted
  // principal also has a separate budget so query load cannot starve delivery.
  const ingressLimiter = limiter("audit:http:ip:", 1200);
  const ingestionLimiter = limiter("audit:http:ingest:", 600, (req) => req.auditCaller.subject);
  const queryLimiter = limiter("audit:http:read:", 120, (req) => req.auditCaller.subject);
  const authenticate = serviceAuthentication(trustedKeys);
  // Health must remain available when the database-backed limiter is unavailable.
  // These cheap process-local budgets bound readiness pings without requiring DB writes.
  const healthLimiter = rateLimit({ windowMs: 60000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false,
    message: { error: { code: "RATE_LIMIT_EXCEEDED", message: "Health request budget exhausted." } } });
  app.get("/health/live", healthLimiter, (_req, res) => res.json({ status: "UP", service: "worksphere-audit" }));
  app.get("/health/ready", healthLimiter, async (_req, res) => {
    let ready = initialized && !draining;
    if (ready) {
      try { await db.command({ ping: 1 }, { maxTimeMS: 2000 }); }
      catch { ready = false; }
    }
    res.status(ready ? 200 : 503).json({ status: ready ? "UP" : "DOWN", service: "worksphere-audit" });
  });
  app.use("/internal", (_req, _res, next) => {
    if (!initialized || draining) return next(new AppError(503, "AUDIT_UNAVAILABLE", "Audit is not accepting requests."));
    next();
  });

  // Authenticate before parsing. Compression is disabled and the raw JSON limit
  // equals the versioned envelope limit, bounding work before domain validation.
  const json = express.json({ limit: MAX_AUDIT_EVENT_BYTES, inflate: false });
  app.post("/internal/v1/events", ingressLimiter, authenticate, allowIngestion, ingestionLimiter, json, async (req, res) => {
    let event;
    try { event = validateAuditEnvelope(req.body); }
    catch { throw new AppError(400, "INVALID_AUDIT_EVENT", "A valid version-1 audit envelope is required."); }
    if (event.producer !== req.auditCaller.subject)
      throw new AppError(403, "AUDIT_FORBIDDEN", "The event producer must match its authenticated service.");
    const result = await consumer.consume(event, { producer: req.auditCaller.subject });
    // An acknowledgment follows the receiver's majority write, including on a
    // deduplicated retry. Echo immutable identity so senders can validate the ACK.
    res.status(result.duplicate ? 200 : 201).json({ data: { eventId: event.eventId, producer: event.producer, ...result } });
  });
  app.get("/internal/v1/events", ingressLimiter, authenticate, allowQueries, queryLimiter,
    async (req, res) => res.json(await reader.listEvents(req.query)));
  app.get("/internal/v1/events/:id", ingressLimiter, authenticate, allowQueries, queryLimiter,
    async (req, res) => res.json({ data: await reader.getEvent(req.params.id) }));
  app.use((_req, _res, next) => next(new AppError(404, "NOT_FOUND", "Audit endpoint not found.")));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    let status = 503, code = "AUDIT_UNAVAILABLE", message = "Audit storage is unavailable. Retry later.";
    if (error instanceof AppError) ({ status, code, message } = error);
    else if (error.code === "AUDIT_DELIVERY_CONFLICT") {
      status = 409; code = error.code; message = "Audit delivery conflicts with retained history.";
    } else if (error.type === "entity.too.large") {
      status = 413; code = "PAYLOAD_TOO_LARGE"; message = "Audit envelope exceeds 64 KiB.";
    } else if (error.type === "entity.parse.failed") {
      status = 400; code = "INVALID_JSON"; message = "A valid JSON envelope is required.";
    } else if (error.status === 415) {
      status = 415; code = "UNSUPPORTED_ENCODING"; message = "Compressed audit requests are not supported.";
    }
    if (status >= 500) {
      res.set("Retry-After", "1");
      logger.error("audit_http_unavailable", { requestId: req.requestId, code });
    }
    res.status(status).json({ error: { code, message }, requestId: req.requestId });
  });

  return {
    app,
    async initialize() {
      initialized = false;
      await consumer.initialize();
      try { await db.createCollection(RATE_LIMIT_COLLECTION); }
      catch (error) { if (error.code !== 48) throw error; }
      // Only disposable request counters expire; audit history/identities never do.
      await budgets.createIndex({ resetTime: 1 }, { expireAfterSeconds: 0, name: "audit_request_expiration" });
      initialized = true;
    },
    beginShutdown() { draining = true; },
  };
}

module.exports = { createAuditService, RATE_LIMIT_COLLECTION };
