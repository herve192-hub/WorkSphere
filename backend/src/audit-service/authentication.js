const jwt = require("jsonwebtoken");
const AppError = require("../utils/AppError");

const ISSUER = "worksphere-internal";
const AUDIENCE = "worksphere-audit";
const MAX_TOKEN_AGE_SECONDS = 60;

/**
 * Select a configured client key, then verify its signed subject and claims.
 * Decoding selects a candidate only; no decoded data grants access until verify.
 * Short-lived bearer tokens permit delivery retries within their validity window.
 */
function serviceAuthentication(keys) {
  return (req, res, next) => {
    try {
      const header = req.get("authorization");
      if (typeof header !== "string" || header.length > 4096 || !/^Bearer [^\s]+$/.test(header)) throw new Error();
      const token = header.slice(7);
      const candidate = jwt.decode(token);
      const subject = candidate?.sub;
      if (typeof subject !== "string" || !Object.hasOwn(keys, subject)) throw new Error();
      const claims = jwt.verify(token, keys[subject], {
        algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE, subject,
        maxAge: MAX_TOKEN_AGE_SECONDS,
      });
      const now = Math.floor(Date.now() / 1000);
      // Require explicit bounded expiry and reject future-issued tokens rather
      // than letting a caller extend maxAge by choosing a later iat timestamp.
      if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) ||
          claims.iat > now || claims.exp <= claims.iat || claims.exp - claims.iat > MAX_TOKEN_AGE_SECONDS)
        throw new Error();
      req.auditCaller = Object.freeze({ subject: claims.sub, actorId: claims.actorId, role: claims.role });
      next();
    } catch {
      res.set("WWW-Authenticate", 'Bearer realm="worksphere-audit"');
      next(new AppError(401, "INVALID_SERVICE_TOKEN", "A valid Audit service token is required."));
    }
  };
}

function allowIngestion(req, _res, next) {
  if (!["employees", "identity"].includes(req.auditCaller.subject))
    return next(new AppError(403, "AUDIT_FORBIDDEN", "This service cannot ingest audit events."));
  next();
}

function allowQueries(req, _res, next) {
  const caller = req.auditCaller;
  // Only the API may attest a currently authorized browser principal. Producers
  // cannot acquire query access by adding a role claim to their own signed token.
  if (caller.subject !== "api" || !["ADMIN", "HR_MANAGER"].includes(caller.role) ||
      typeof caller.actorId !== "string" || !/^[a-f0-9]{24}$/.test(caller.actorId))
    return next(new AppError(403, "AUDIT_FORBIDDEN", "An authorized API principal is required."));
  next();
}

module.exports = { serviceAuthentication, allowIngestion, allowQueries, ISSUER, AUDIENCE, MAX_TOKEN_AGE_SECONDS };
