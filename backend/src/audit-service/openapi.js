// The private transport reuses public history schemas while keeping service
// credentials, ingestion, and browser cookie authentication separate contracts.
const publicApi = require("../docs/openapi");
const schemas = publicApi.components.schemas;
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (description, schema) => ({ description, content: { "application/json": { schema } } });
const error = (description) => json(description, ref("Error"));
const errors = { 400: error("Invalid envelope, query, ID, or JSON."), 401: error("Invalid or expired service token."),
  403: error("Service, producer, or forwarded principal is not authorized."),
  429: { ...error("Request budget exhausted."), headers: { "Retry-After": { schema: { type: "integer", minimum: 1 }, description: "Seconds until quota resets." } } },
  503: error("Service draining, not initialized, or storage unavailable; retain intent and retry.") };
const health = { type: "object", required: ["status", "service"], additionalProperties: false,
  properties: { status: { type: "string", enum: ["UP", "DOWN"] }, service: { type: "string", enum: ["worksphere-audit"] } } };
const envelopeFields = { ...schemas.AuditEvent.properties };
delete envelopeFields._id;

module.exports = {
  openapi: "3.0.4", info: { title: "WorkSphere private Audit service", version: "1.0.0",
    description: "Internal service calls only. HS256 tokens use per-client secrets, issuer worksphere-internal, audience worksphere-audit, and explicit iat/exp at most 60 seconds apart. Subjects employees/identity may ingest only their own envelopes. Subject api may query only with a signed actorId and ADMIN/HR_MANAGER role. The API must verify the live browser session before attesting that principal." },
  servers: [{ url: "http://127.0.0.1:5001" }], security: [{ serviceBearer: [] }],
  paths: {
    "/health/live": { get: { operationId: "auditLiveness", security: [], responses: { 200: json("HTTP process live.", health), 429: errors[429] } } },
    "/health/ready": { get: { operationId: "auditReadiness", security: [], responses: { 200: json("Initialized and database reachable.", health), 503: json("Not initialized, draining, or database unavailable.", health), 429: errors[429] } } },
    "/internal/v1/events": {
      post: { operationId: "ingestAuditEvent", description: "One raw version-1 envelope, maximum 64 KiB; compressed bodies are rejected. 1200 IP requests/minute before authentication; 600 requests/minute per authenticated producer, shared across replicas. Majority persistence precedes the ACK. Identical retries retain the original audit ID. Retain event identity on unknown outcomes.",
        requestBody: { required: true, content: { "application/json": { schema: ref("AuditEnvelope") } } },
        responses: { ...errors, 201: json("Event persisted.", ref("AuditAcknowledgment")), 200: json("Identical event already persisted.", ref("AuditAcknowledgment")),
          409: error("Event identity or stream position conflicts with retained history; never overwrite."),
          413: error("Envelope exceeds 64 KiB."), 415: error("Compressed requests are unsupported.") } },
      get: { operationId: "queryAuditEvents", description: "1200 IP requests/minute plus 120 API query requests/minute shared across replicas. Same filters, ordering, and response shape as the browser API; private delivery fields are hidden.",
        parameters: publicApi.paths["/api/v1/audit"].get.parameters, responses: { ...errors, 200: json("History results.", ref("AuditList")) } },
    },
    "/internal/v1/events/{id}": { get: { operationId: "queryAuditEvent", parameters: [{ $ref: "#/components/parameters/AuditId" }],
      responses: { ...errors, 200: json("History event.", ref("AuditResponse")), 404: error("Audit event not found.") } } },
  },
  components: {
    securitySchemes: { serviceBearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    parameters: Object.fromEntries(["Page", "Limit", "RequestId", "AuditId"].map((name) => [name, publicApi.components.parameters[name]])),
    schemas: {
      ...Object.fromEntries(["Error", "Pagination", "AuditActor", "AuditEvent", "AuditList", "AuditResponse"].map((name) => [name, schemas[name]])),
      AuditEnvelope: { type: "object", additionalProperties: false,
        required: ["eventId", "schemaVersion", "producer", "sequence", "occurredAt", "action", "actor", "resource", "requestId", "changes"],
        properties: { ...envelopeFields, eventId: { type: "string", format: "uuid" }, schemaVersion: { type: "integer", enum: [1] },
          producer: { type: "string", enum: ["employees", "identity"] }, sequence: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } } },
      AuditAcknowledgment: { type: "object", required: ["data"], additionalProperties: false,
        properties: { data: { type: "object", additionalProperties: false, required: ["eventId", "producer", "auditId", "duplicate"],
          properties: { eventId: { type: "string", format: "uuid" }, producer: { type: "string", enum: ["employees", "identity"] },
            auditId: { type: "string", pattern: "^[a-f0-9]{24}$" }, duplicate: { type: "boolean" } } } } },
    },
  },
};
