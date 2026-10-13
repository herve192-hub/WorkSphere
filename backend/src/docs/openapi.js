// Canonical API contract, served at /openapi.json and validated in CI.
// This document defines the public WorkSphere API surface, including the shared
// schema helpers, endpoint contracts, and response metadata used by Swagger UI
// and CI validation. It intentionally keeps compatibility aliases for legacy
// firstname/lastname fields while documenting the canonical names.
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const param = (name) => ({ $ref: `#/components/parameters/${name}` });
const json = (description, schema) => ({ description, content: { "application/json": { schema } } });
const error = (description) => json(description, ref("Error"));
const body = (schema) => ({ required: true, content: { "application/json": { schema } } });
const data = (schema) => ({ type: "object", required: ["data"], properties: { data: schema } });
const list = (name) => ({ type: "object", required: ["data", "pagination"], properties: { data: { type: "array", items: ref(name) }, pagination: ref("Pagination") } });
const objectId = { type: "string", pattern: "^[a-fA-F0-9]{24}$" };
const nullableId = { ...objectId, nullable: true };
const nullableDate = { type: "string", format: "date-time", nullable: true };
const roles = ["ADMIN", "HR_MANAGER", "EMPLOYEE"];
const statuses = ["ACTIVE", "ON_LEAVE", "INACTIVE", "TERMINATED"];
const actions = ["EMPLOYEE_CREATED", "EMPLOYEE_UPDATED", "EMPLOYEE_DELETED", "AUTH_REGISTERED", "AUTH_LOGIN", "AUTH_LOGIN_FAILED", "AUTH_REFRESHED", "AUTH_LOGOUT"];
const names = {
  firstName: { type: "string", minLength: 1, maxLength: 80, description: "Canonical first name; whitespace is trimmed." },
  lastName: { type: "string", minLength: 1, maxLength: 80, description: "Canonical last name; whitespace is trimmed." },
  firstname: { type: "string", deprecated: true, description: "Legacy alias; must match firstName after trimming when both are supplied." },
  lastname: { type: "string", deprecated: true, description: "Legacy alias; must match lastName after trimming when both are supplied." },
};
const employeeFields = {
  ...names, email: { type: "string", format: "email", maxLength: 254, description: "Trimmed and lowercased." },
  phone: { type: "string", maxLength: 40 }, jobTitle: { type: "string", maxLength: 120 },
  department: { type: "string", maxLength: 120 }, location: { type: "string", maxLength: 160 },
  employmentStatus: { type: "string", enum: statuses, default: "ACTIVE" },
  hireDate: { type: "string", nullable: true, description: "YYYY-MM-DD or UTC ISO timestamp. Empty string or null clears the date." },
  managerId: { ...nullableId, description: "Existing active/on-leave employee; cycles are rejected. null clears the manager; omission retains it on PATCH." },
  avatarUrl: { type: "string", maxLength: 500, description: "Empty string or HTTP/HTTPS URL without credentials." },
};
const profileRequired = [
  { anyOf: [{ required: ["firstName"] }, { required: ["firstname"] }] },
  { anyOf: [{ required: ["lastName"] }, { required: ["lastname"] }] },
];
const protectedErrors = { 401: error("Missing, expired, rotated, or revoked session."), 403: error("Role, employee scope, or Origin restriction.") };
const writeErrors = { ...protectedErrors, 400: error("Invalid fields, employee number, manager, reporting cycle, or malformed JSON."), 409: error("Duplicate resource; manager has reports or a broken reporting chain."), 413: error("JSON body exceeds 16 KiB."), 500: error("Server failure; transactional changes are rolled back.") };
const origin = [param("Origin")];
const employeeId = [param("EmployeeId")];
const authResponse = json("Account profile; HttpOnly access/refresh cookies are set after commit.", ref("AccountResponse"));
authResponse.headers = { "Set-Cookie": { description: "ws_access: 15 minutes; ws_refresh: seven days. HttpOnly, SameSite=Strict, Path=/api/v1; Secure in production.", schema: { type: "string" } } };

module.exports = {
  openapi: "3.0.4",
  info: {
    title: "WorkSphere API", version: "1.0.0",
    description: "Employee-management API using browser-managed HttpOnly cookies. Every API mutation requires Origin to exactly match CLIENT_ORIGIN. Public registration assigns EMPLOYEE. Successful employee/account/session changes commit together with audit history using MongoDB replica-set/sharded transactions. Swagger UI permits GET requests only; use the web app or a cookie-aware HTTP client for mutations. Responses retain legacy firstname/lastname aliases during migration.",
  },
  servers: [{ url: "/", description: "This API host" }],
  tags: [{ name: "Authentication", description: "Account/session lifecycle." }, { name: "Employees", description: "Directory and reporting relationships." }, { name: "Audit", description: "Read-only persistent history for ADMIN and HR_MANAGER." }, { name: "Health", description: "Public operational probes." }],
  security: [{ accessCookie: [] }],
  paths: {
    "/api/v1/auth/register": { post: {
      operationId: "registerAccount", tags: ["Authentication"], summary: "Register an employee account", security: [], parameters: origin,
      description: "Creates an EMPLOYEE account and AUTH_REGISTERED event. Caller-supplied role is ignored. No session or cookies are created.", requestBody: body(ref("Registration")),
      responses: { 201: json("Created account; no session.", ref("AccountResponse")), 400: error("Invalid profile or password; use 12 characters and at most 72 UTF-8 bytes."), 403: protectedErrors[403], 409: error("Email already registered."), 413: writeErrors[413], 429: error("Register/login share 20 IP attempts per 15 minutes."), 500: writeErrors[500] },
    } },
    "/api/v1/auth/login": { post: {
      operationId: "login", tags: ["Authentication"], summary: "Sign in", security: [], parameters: origin, requestBody: body(ref("Login")),
      description: "Creates a session and AUTH_LOGIN event. Invalid credentials record AUTH_LOGIN_FAILED without a verified actor or submitted credentials.",
      responses: { 200: authResponse, 400: error("Malformed JSON."), 401: error("Email/password incorrect."), 403: protectedErrors[403], 413: writeErrors[413], 429: error("Register/login share 20 IP attempts per 15 minutes."), 500: writeErrors[500] },
    } },
    "/api/v1/auth/refresh": { post: {
      operationId: "refreshSession", tags: ["Authentication"], summary: "Rotate a session", security: [{ refreshCookie: [] }], parameters: origin,
      description: "Consumes the old session and records AUTH_REFRESHED with the replacement. Old access/refresh cookies stop working. Invalid refresh clears cookies.",
      responses: { 200: authResponse, 400: error("Malformed JSON."), ...protectedErrors, 413: writeErrors[413], 500: writeErrors[500] },
    } },
    "/api/v1/auth/logout": { post: {
      operationId: "logout", tags: ["Authentication"], summary: "Sign out", security: [{}, { refreshCookie: [] }], parameters: origin,
      description: "Revokes the refresh-cookie session and records AUTH_LOGOUT when the account exists; clears cookies. Repeating logout is safe.",
      responses: { 204: { description: "Session revoked; cookies cleared; no body." }, 400: error("Malformed JSON."), 403: protectedErrors[403], 413: writeErrors[413], 500: writeErrors[500] },
    } },
    "/api/v1/auth/me": { get: { operationId: "currentAccount", tags: ["Authentication"], summary: "Read the signed-in account", "x-roles": roles, responses: { 200: json("Current profile.", ref("AccountResponse")), 401: protectedErrors[401], 500: writeErrors[500] } } },
    "/api/v1/employees": {
      get: {
        operationId: "listEmployees", tags: ["Employees"], summary: "Search the directory", "x-roles": roles,
        description: "EMPLOYEE reads only records matching their account email. Managers see the directory. Search is a literal case-insensitive substring; sorting has an _id tie-breaker. Unknown/repeated parameters are rejected.",
        parameters: [param("Page"), param("Limit"),
          { name: "search", in: "query", schema: { type: "string", maxLength: 254 } }, { name: "department", in: "query", schema: { type: "string", maxLength: 120 } },
          { name: "status", in: "query", description: "Case-insensitive status.", schema: { type: "string", enum: statuses } },
          { name: "sortBy", in: "query", schema: { type: "string", enum: ["firstName", "lastName", "firstname", "lastname", "email", "employeeNumber", "department", "jobTitle", "hireDate", "createdAt"], default: "createdAt" } },
          { name: "sortOrder", in: "query", schema: { type: "string", enum: ["asc", "desc"], default: "desc" } }],
        responses: { 200: json("Directory results.", ref("EmployeeList")), 400: error("Invalid query."), 401: protectedErrors[401], 500: writeErrors[500] },
      },
      post: {
        operationId: "createEmployee", tags: ["Employees"], summary: "Create an employee", "x-roles": ["ADMIN", "HR_MANAGER"], parameters: origin,
        description: "Generates an immutable employee number and commits EMPLOYEE_CREATED history with the record. employeeNumber input is rejected; unknown fields are ignored. Failed creates can leave number gaps.",
        requestBody: body(ref("EmployeeCreate")), responses: { 201: json("Employee created.", ref("EmployeeResponse")), ...writeErrors },
      },
    },
    "/api/v1/employees/{id}": {
      get: { operationId: "getEmployee", tags: ["Employees"], summary: "Read one employee", "x-roles": roles, parameters: employeeId, responses: { 200: json("Employee record.", ref("EmployeeResponse")), 400: error("Invalid ID."), ...protectedErrors, 404: error("Employee not found."), 500: writeErrors[500] } },
      patch: {
        operationId: "updateEmployee", tags: ["Employees"], summary: "Update an employee", "x-roles": ["ADMIN", "HR_MANAGER"], parameters: [...employeeId, ...origin],
        description: "At least one supported field is required. Numbers cannot change. Before making a manager INACTIVE/TERMINATED, reassign/clear every direct report. EMPLOYEE_UPDATED retains before/after changes; unchanged writes have an empty changes array.",
        requestBody: body(ref("EmployeePatch")), responses: { 200: json("Employee updated.", ref("EmployeeResponse")), ...writeErrors, 404: error("Employee not found.") },
      },
      delete: { operationId: "deleteEmployee", tags: ["Employees"], summary: "Delete an employee", "x-roles": ["ADMIN"], parameters: [...employeeId, ...origin], description: "Reassign/clear all direct reports first. EMPLOYEE_DELETED retains the employee number and previous values after deletion.", responses: { 204: { description: "Employee deleted; no body." }, ...writeErrors, 404: error("Employee not found.") } },
    },
    "/api/v1/audit": { get: {
      operationId: "listAuditEvents", tags: ["Audit"], summary: "Search audit history", "x-roles": ["ADMIN", "HR_MANAGER"],
      description: "Newest first with an _id tie-breaker. Actor/resource snapshots survive changes. No event write/delete API. Unknown/repeated parameters and invalid date ranges are rejected.",
      parameters: [param("Page"), param("Limit"), { name: "action", in: "query", schema: { type: "string", enum: actions } }, { name: "actorId", in: "query", schema: objectId }, { name: "resourceType", in: "query", schema: { type: "string", enum: ["EMPLOYEE", "ACCOUNT"] } }, { name: "resourceId", in: "query", schema: objectId },
        { name: "search", in: "query", description: "Literal case-insensitive substring in actor name/email or resource label (employee number/account email).", schema: { type: "string", maxLength: 254 } },
        ...["from", "to"].map((name) => ({ name, in: "query", description: "Inclusive UTC calendar date or UTC ISO timestamp. A date-only 'to' includes the full UTC day.", schema: { type: "string" }, example: "2026-10-09" }))],
      responses: { 200: json("History results.", ref("AuditList")), 400: error("Invalid query."), ...protectedErrors, 500: writeErrors[500] },
    } },
    "/api/v1/audit/{id}": { get: { operationId: "getAuditEvent", tags: ["Audit"], summary: "Read an audit event", "x-roles": ["ADMIN", "HR_MANAGER"], parameters: [param("AuditId")], responses: { 200: json("Audit event.", ref("AuditResponse")), 400: error("Invalid ID."), ...protectedErrors, 404: error("Audit event not found."), 500: writeErrors[500] } } },
    "/health/live": { get: { operationId: "liveness", tags: ["Health"], summary: "Check process liveness", security: [], responses: { 200: json("Process serving HTTP.", ref("LiveHealth")) } } },
    "/health/ready": { get: { operationId: "readiness", tags: ["Health"], summary: "Check MongoDB readiness", security: [], responses: { 200: json("MongoDB connected.", ref("ReadyHealth")), 503: json("MongoDB disconnected.", ref("ReadyHealth")) } } },
    "/health": { get: { operationId: "legacyHealth", tags: ["Health"], summary: "Legacy process health", deprecated: true, security: [], responses: { 200: json("Prefer /health/ready for readiness.", ref("LiveHealth")) } } },
  },
  components: {
    securitySchemes: {
      accessCookie: { type: "apiKey", in: "cookie", name: "ws_access", description: "Browser-managed HttpOnly JWT backed by an active session. Do not paste tokens into Swagger UI." },
      refreshCookie: { type: "apiKey", in: "cookie", name: "ws_refresh", description: "Browser-managed HttpOnly rotating refresh token." },
    },
    parameters: {
      RequestId: { name: "X-Request-Id", in: "header", description: "Optional correlation ID: 1–128 letters, digits, dots, underscores, colons, or hyphens. Unsafe/missing values are replaced by a generated UUID; responses and audit events carry the effective ID.", schema: { type: "string", maxLength: 128 } },
      Origin: { name: "Origin", in: "header", required: true, description: "Must exactly match CLIENT_ORIGIN. Browsers supply this header; documentation does not bypass it.", schema: { type: "string" }, example: "http://localhost:3000" },
      Page: { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
      Limit: { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
      EmployeeId: { name: "id", in: "path", required: true, schema: objectId }, AuditId: { name: "id", in: "path", required: true, schema: objectId },
    },
    schemas: {
      Error: { type: "object", required: ["error"], properties: { error: { type: "object", required: ["message"], properties: { message: { type: "string" }, code: { type: "string" }, details: { type: "object", additionalProperties: true } } }, requestId: { type: "string" } } },
      Pagination: { type: "object", required: ["page", "limit", "totalItems", "totalPages"], properties: { page: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 100 }, totalItems: { type: "integer", minimum: 0 }, totalPages: { type: "integer", minimum: 0 } } },
      Registration: { type: "object", required: ["email", "password"], allOf: profileRequired, properties: { ...names, email: employeeFields.email, password: { type: "string", minLength: 12, maxLength: 72, writeOnly: true, description: "At most 72 UTF-8 bytes; multibyte characters use more than one byte." } }, example: { firstName: "Jamie", lastName: "Morgan", email: "jamie@example.com", password: "a memorable example passphrase" } },
      Login: { type: "object", required: ["email", "password"], properties: { email: employeeFields.email, password: { type: "string", writeOnly: true } } },
      Account: { type: "object", required: ["id", "firstName", "lastName", "email", "role"], properties: { id: objectId, ...names, email: employeeFields.email, role: { type: "string", enum: roles } } }, AccountResponse: data(ref("Account")),
      EmployeeCreate: { type: "object", required: ["email"], allOf: profileRequired, not: { required: ["employeeNumber"] }, properties: employeeFields, example: { firstName: "Jamie", lastName: "Morgan", email: "jamie@example.com", department: "Engineering", hireDate: "2026-01-15" } },
      EmployeePatch: { type: "object", minProperties: 1, not: { required: ["employeeNumber"] }, properties: employeeFields },
      Employee: { type: "object", required: ["_id", "firstName", "lastName", "email"], properties: { _id: objectId, ...employeeFields, employeeNumber: { type: "string", readOnly: true, description: "Generated EMP- sequence; legacy numbers are preserved." }, hireDate: nullableDate, managerId: nullableId, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" } } }, EmployeeResponse: data(ref("Employee")), EmployeeList: list("Employee"),
      AuditActor: { type: "object", nullable: true, required: ["id", "firstName", "lastName", "email", "role"], additionalProperties: false, properties: { id: objectId, firstName: { type: "string" }, lastName: { type: "string" }, email: { type: "string", format: "email" }, role: { type: "string", enum: roles } } },
      AuditEvent: { type: "object", required: ["_id", "action", "actor", "resource", "changes", "requestId", "occurredAt"], additionalProperties: false, properties: {
        _id: objectId, action: { type: "string", enum: actions }, actor: ref("AuditActor"),
        resource: { type: "object", required: ["type", "id", "label"], additionalProperties: false, properties: { type: { type: "string", enum: ["EMPLOYEE", "ACCOUNT"] }, id: nullableId, label: { type: "string" } } },
        changes: { type: "array", items: { type: "object", required: ["field", "before", "after"], additionalProperties: false, properties: { field: { type: "string" }, before: { type: "string", nullable: true }, after: { type: "string", nullable: true } } } },
        requestId: { type: "string" }, occurredAt: { type: "string", format: "date-time" },
      } }, AuditResponse: data(ref("AuditEvent")), AuditList: list("AuditEvent"),
      LiveHealth: { type: "object", required: ["status", "service"], properties: { status: { type: "string", enum: ["UP"] }, service: { type: "string", enum: ["worksphere-api"] } } },
      ReadyHealth: { type: "object", required: ["status", "service", "dependencies"], properties: { status: { type: "string", enum: ["UP", "DOWN"] }, service: { type: "string", enum: ["worksphere-api"] }, dependencies: { type: "object", required: ["mongodb"], properties: { mongodb: { type: "string", enum: ["UP", "DOWN"] } } } } },
    },
  },
};

for (const path of Object.values(module.exports.paths)) {
  for (const operation of Object.values(path)) {
    operation.parameters = [...(operation.parameters || []), param("RequestId")];
    for (const response of Object.values(operation.responses)) {
      response.headers = { ...response.headers, "X-Request-Id": { description: "Effective request correlation ID.", schema: { type: "string" } } };
    }
  }
}
