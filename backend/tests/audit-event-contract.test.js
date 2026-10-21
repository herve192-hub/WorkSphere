const { test } = require("node:test");
const assert = require("node:assert/strict");
const { AUDIT_ACTIONS, EMPLOYEE_AUDIT_FIELDS, MAX_AUDIT_EVENT_BYTES, prepareAuditEvent } = require("../src/contracts/auditEvent");

const actorId = "abcdefabcdefabcdefabcdef";
const resourceId = "123456789012345678901234";
const metadata = { producer: "employees", eventId: "00000000-0000-4000-8000-000000000001", occurredAt: "2026-01-01T00:00:00.000Z" };
function payload() {
  return {
    action: "EMPLOYEE_UPDATED", requestId: "request-123",
    actor: { id: actorId, firstName: "Jamie", lastName: "Morgan", email: "jamie@example.com", role: "HR_MANAGER" },
    resource: { type: "EMPLOYEE", id: resourceId, label: "EMP-000001" },
    changes: [{ field: "department", before: "Engineering", after: "Platform" }],
  };
}

test("version 1 captures detached, canonical snapshots with stable producer metadata", () => {
  const input = payload();
  input.actor.id = actorId.toUpperCase();
  const event = prepareAuditEvent(input, metadata);
  assert.deepEqual(event, { ...payload(), ...metadata, schemaVersion: 1 });
  input.actor.firstName = "Changed";
  input.resource.label = "Changed";
  input.changes[0].after = "Changed";
  assert.equal(event.actor.firstName, "Jamie");
  assert.equal(event.resource.label, "EMP-000001");
  assert.equal(event.changes[0].after, "Platform");
  const generated = prepareAuditEvent(payload(), { producer: "employees" });
  assert.match(generated.eventId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(new Date(generated.occurredAt).toISOString(), generated.occurredAt);
});

test("only the producing domain's actions and resource types are accepted", () => {
  for (const action of AUDIT_ACTIONS) {
    const input = payload();
    const producer = action.startsWith("EMPLOYEE_") ? "employees" : "identity";
    input.action = action;
    if (producer === "identity") {
      input.resource = { type: "ACCOUNT", id: actorId, label: input.actor.email };
      input.changes = [];
      if (action === "AUTH_LOGIN_FAILED") { input.actor = null; input.resource = { type: "ACCOUNT", id: null, label: "" }; }
    }
    assert.equal(prepareAuditEvent(input, { ...metadata, producer }).action, action);
    assert.throws(() => prepareAuditEvent(input, { ...metadata, producer: producer === "identity" ? "employees" : "identity" }), TypeError);
  }
  for (const producer of [undefined, "audit", "__proto__"])
    assert.throws(() => prepareAuditEvent(payload(), { ...metadata, producer }), TypeError);
  assert.throws(() => prepareAuditEvent({ ...payload(), action: "UNKNOWN" }, metadata), TypeError);
  assert.throws(() => prepareAuditEvent({ ...payload(), resource: { ...payload().resource, type: "ACCOUNT" } }, metadata), TypeError);
});

test("unknown properties and sensitive or nested changes fail closed", () => {
  for (const sensitive of ["password", "passwordHash", "tokenHash", "cookies", "headers", "body"]) {
    assert.throws(() => prepareAuditEvent({ ...payload(), [sensitive]: "fixture-only" }, metadata), TypeError);
    assert.throws(() => prepareAuditEvent({ ...payload(), actor: { ...payload().actor, [sensitive]: "fixture-only" } }, metadata), TypeError);
    assert.throws(() => prepareAuditEvent({ ...payload(), resource: { ...payload().resource, [sensitive]: "fixture-only" } }, metadata), TypeError);
    assert.throws(() => prepareAuditEvent({ ...payload(), changes: [{ field: sensitive, before: null, after: "fixture-only" }] }, metadata), TypeError);
  }
  for (const after of [{ nested: "fixture-only" }, [], 123, true, undefined])
    assert.throws(() => prepareAuditEvent({ ...payload(), changes: [{ field: "department", before: null, after }] }, metadata), TypeError);
  const change = payload().changes[0];
  assert.throws(() => prepareAuditEvent({ ...payload(), changes: [change, change] }, metadata), TypeError);
  assert.throws(() => prepareAuditEvent({ ...payload(), changes: [{ ...change, password: "fixture-only" }] }, metadata), TypeError);
  assert.throws(() => prepareAuditEvent({ ...payload(), schemaVersion: 2 }, metadata), TypeError);
});

test("failed logins cannot capture attempted identities or arbitrary change data", () => {
  const input = { action: "AUTH_LOGIN_FAILED", actor: null, resource: { type: "ACCOUNT", id: null, label: "" }, requestId: "request-123" };
  const options = { ...metadata, producer: "identity" };
  assert.deepEqual(prepareAuditEvent(input, options).changes, []);
  for (const extra of [
    { actor: payload().actor }, { resource: { ...input.resource, id: actorId } },
    { resource: { ...input.resource, label: "attempted@example.com" } }, { changes: payload().changes },
  ]) assert.throws(() => prepareAuditEvent({ ...input, ...extra }, options), TypeError);
  assert.throws(() => prepareAuditEvent({ ...payload(), action: "AUTH_LOGIN", resource: { type: "ACCOUNT", id: resourceId, label: "" }, changes: [] }, options), TypeError);
});

test("invalid IDs, timestamps, correlation IDs, actors, and oversized envelopes are rejected", () => {
  for (const eventId of [null, "invalid", "00000000-0000-1000-8000-000000000001"])
    assert.throws(() => prepareAuditEvent(payload(), { ...metadata, eventId }), TypeError);
  for (const occurredAt of ["invalid", "2026-02-31T00:00:00.000Z", "2026-01-01", null])
    assert.throws(() => prepareAuditEvent(payload(), { ...metadata, occurredAt }), TypeError);
  for (const requestId of [undefined, "", "unsafe request", "x".repeat(129), { nested: true }])
    assert.throws(() => prepareAuditEvent({ ...payload(), requestId }, metadata), TypeError);
  for (const actor of [null, { ...payload().actor, id: "invalid" }, { ...payload().actor, role: "ROOT" }, { ...payload().actor, firstName: "" }])
    assert.throws(() => prepareAuditEvent({ ...payload(), actor }, metadata), TypeError);
  assert.throws(() => prepareAuditEvent({ ...payload(), resource: { ...payload().resource, id: null } }, metadata), TypeError);
  const large = { ...payload(), changes: EMPLOYEE_AUDIT_FIELDS.map((field) => ({ field, before: "界".repeat(1000), after: "界".repeat(1000) })) };
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > MAX_AUDIT_EVENT_BYTES);
  assert.throws(() => prepareAuditEvent(large, metadata), /64 KiB/);
});
