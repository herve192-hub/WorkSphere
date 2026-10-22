// Invoked only inside verify-containers.sh's disposable API container/database.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(`${process.cwd()}/package.json`);
const jwt = require("jsonwebtoken");
const { prepareAuditEvent } = require("./src/contracts/auditEvent");
const keys = Object.fromEntries(["employees", "identity", "api"].map((name) => [name, randomBytes(32).toString("hex")]));
const mongoUri = new URL(process.env.MONGO_URI);
mongoUri.pathname = "/worksphere_audit_smoke";
// The existing built image must contain this independent runtime and all its
// production dependencies. No service receives the browser signing credential.
const child = spawn(process.execPath, ["scripts/audit-service.js"], { env: {
  ...process.env, JWT_ACCESS_SECRET: "", AUDIT_MONGO_URI: mongoUri.href,
  AUDIT_SERVICE_KEYS: JSON.stringify(keys), AUDIT_HOST: "127.0.0.1", AUDIT_PORT: "0",
}, stdio: ["ignore", "pipe", "pipe"] });
let output = "", startupTimer;
child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-20000); });
child.stderr.resume(); // Service failures are sanitized; never print configuration.
try {
  const port = await new Promise((resolve, reject) => {
    startupTimer = setTimeout(() => reject(new Error("Audit service readiness timed out.")), 20000);
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Audit service exited before readiness.")));
    child.stdout.on("data", () => {
      for (const line of output.split("\n")) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.message === "audit_service_ready") { resolve(entry.port); return; }
      }
    });
  });
  clearTimeout(startupTimer);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const endpoint = `http://127.0.0.1:${port}`;
  const actorId = "abcdefabcdefabcdefabcdef";
  const bearer = (subject) => jwt.sign(subject === "api" ? { actorId, role: "ADMIN" } : {}, keys[subject],
    { algorithm: "HS256", issuer: "worksphere-internal", audience: "worksphere-audit", subject, expiresIn: 60 });
  const call = async (method, route, subject, body) => {
    const response = await fetch(endpoint + route, { method,
      headers: { ...(subject ? { Authorization: `Bearer ${bearer(subject)}` } : {}), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call("GET", "/health/ready")).status, 200);
  assert.equal((await call("GET", "/internal/v1/events")).status, 401);
  const event = { ...prepareAuditEvent({ action: "EMPLOYEE_CREATED", requestId: "audit-runtime-smoke",
    actor: { id: actorId, firstName: "Test", lastName: "Fixture", email: "fixture@example.com", role: "ADMIN" },
    resource: { type: "EMPLOYEE", id: "123456789012345678901234", label: "EMP-000001" }, changes: [],
  }, { producer: "employees" }), sequence: 1 };
  const created = await call("POST", "/internal/v1/events", "employees", event);
  assert.equal(created.status, 201);
  const replay = await call("POST", "/internal/v1/events", "employees", event);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.data, { ...created.body.data, duplicate: true });
  const history = await call("GET", "/internal/v1/events", "api");
  assert.equal(history.status, 200);
  assert.equal(history.body.pagination.totalItems, 1);
  assert.equal(history.body.data[0]._delivery, undefined);
  console.log("Verified standalone Audit runtime, service authentication, isolated history, and idempotent HTTP delivery with production dependencies.");
} finally {
  clearTimeout(startupTimer);
  if (child.exitCode === null && !child.signalCode) {
    const exited = once(child, "exit");
    const timer = setTimeout(() => child.kill("SIGKILL"), 16000);
    child.kill("SIGTERM");
    try {
      const [code, signal] = await exited;
      assert.equal(code, 0); assert.equal(signal, null);
      assert.match(output, /audit_service_stopped/);
    } finally { clearTimeout(timer); }
  }
}
