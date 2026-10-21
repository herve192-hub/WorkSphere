# Audit outbox contract, storage, and consumer

Iteration 2 adds storage primitives, a versioned event contract, an idempotent
Audit consumer, and live producer capture in separate steps. Employee and
authentication APIs now commit pending envelopes alongside business changes and
immediate audit history. Delivery remains a later step; audit reads retain their
current synchronous visibility.

## Ownership and initialization

`backend/src/outbox` exports `createAuditOutbox(db, producer)`. It receives an
explicit native MongoDB database and owns no connection or domain model.

| Producer | Outbox collection | Sequence collection |
| --- | --- | --- |
| `employees` | `employee_audit_outbox` | `employee_audit_sequences` |
| `identity` | `identity_audit_outbox` | `identity_audit_sequences` |

Call `initialize()` before accepting producer writes. It creates collections and
indexes explicitly and tolerates repeated or simultaneous startup. Importing the
module or constructing a factory performs no database writes, preserving migration
dry-run behavior. Enqueue rejects an uninitialized factory so it cannot implicitly
create collections without their required indexes. When services split, instantiate
each factory with its owning domain's database and credentials. Audit does not own
these collections.

## Version-1 envelope

The producer supplies only `action`, `actor`, `resource`, `requestId`, and optional
`changes`. The storage layer builds and persists this envelope:

```json
{
  "eventId": "00000000-0000-4000-8000-000000000001",
  "schemaVersion": 1,
  "producer": "employees",
  "sequence": 1,
  "occurredAt": "2026-01-01T00:00:00.000Z",
  "action": "EMPLOYEE_UPDATED",
  "actor": {
    "id": "abcdefabcdefabcdefabcdef",
    "firstName": "Jamie",
    "lastName": "Morgan",
    "email": "jamie@example.com",
    "role": "HR_MANAGER"
  },
  "resource": {
    "type": "EMPLOYEE",
    "id": "123456789012345678901234",
    "label": "EMP-000001"
  },
  "requestId": "request-123",
  "changes": [{ "field": "department", "before": "Engineering", "after": "Platform" }]
}
```

All example identities are synthetic. Event IDs are UUIDv4 strings, timestamps
are canonical UTC ISO strings with milliseconds, and actor/resource IDs are
lowercase ObjectId strings. The envelope fits within 64 KiB of UTF-8 JSON,
including the largest supported sequence number. Producers can supply a trusted
event ID and timestamp to `enqueue` when they have already allocated them; these
are not accepted from public request bodies.

The shared contract supplies the existing action and employee-field allowlists
to both the current Audit model and the outbox. `employees` emits only employee
actions/resources; `identity` emits only authentication actions/account resources.
Authentication actions have no field changes. A verified authentication actor
must match the account resource ID.

Payloads, actors, resources, and changes reject unexpected properties. Actors
contain only the listed public identity fields. Change fields are directory fields
with bounded string/null values; nested values and duplicate change fields are
rejected. Callers must provide explicitly redacted domain data, not whole request
bodies, account documents, credentials, headers, cookies, or tokens.

`AUTH_LOGIN_FAILED` requires `actor: null`, a null resource ID, an empty label,
and no changes. Attempted email addresses are not retained.

`validateAuditEnvelope(input)` validates the complete delivered envelope using
the same redaction rules. Every envelope field is required, including `changes`;
the receiver never invents a missing ID, timestamp, or default. Only schema
version `1` and positive safe-integer sequences are supported. Unsupported
versions and invalid data fail before any storage operation. Validation returns
a detached snapshot with canonical object key order and normalized IDs.

## Transaction and ordering guarantees

`enqueue(payload, { session, eventId?, occurredAt? })` requires an active transaction
from the same MongoClient that owns the factory's database. Missing, inactive,
ended, or foreign-client sessions fail before sequence allocation or insertion.
Use the same transaction for the business operation and enqueue; propagate errors
out of the transaction callback so MongoDB aborts both operations.

MongoDB must support transactions through a replica set or sharded cluster, as
already required by the API. Use `Connection.transaction` or `withTransaction`
to retry transient transaction failures. Enqueue does not independently retry a
business operation or split it into multiple commits.
Commit with `writeConcern: { w: "majority" }` before acknowledging success so a
replica-set failover cannot discard an acknowledged business change and event.
The owning transaction controls commit durability; enqueue cannot strengthen it.

Every resource has a persistent stream, keyed by resource type and ID. Incrementing
that stream's counter and inserting the pending event share the business
transaction. Competing clients contend on the counter; retries obtain a fresh
sequence. Aborted operations roll back allocations. Sequence values are positive
safe integers and determine stream order, independent of producer clock skew.
There is no ordering guarantee between different resources or producers.

Anonymous failed logins use their event ID as a stream key and each start at
sequence 1. They do not create one global authentication bottleneck. Sequence
exhaustion fails the transaction rather than storing an unsafe JSON number.

The outbox document uses the event ID as `_id`, carries `streamId`, and starts
with `status: PENDING`, `attempts: 0`, `availableAt`, and `createdAt`. A unique
stream/sequence index protects ordering metadata. Duplicate event IDs within a
producer fail the transaction and preserve the original event; enqueue does not
replace payloads or implement HTTP-command idempotency. The Audit consumer uses the
producer/event-ID pair to deduplicate delivery independently of enqueue.

Pending events and sequence counters have no TTL. Delivery/retention PRs must
preserve undelivered data and retain sequence allocation even when delivered
records are eventually cleaned up. Worker claims, leases, acknowledgments, and
replay are later steps.

## Idempotent Audit receiver

The public Audit module exports `createAuditConsumer(db)`, taking an explicit
native MongoDB database owned by Audit. Constructing it performs no database
writes. Call and await `initialize()` before `consume(envelope, { producer })`.
Initialization explicitly creates the existing `auditevents` collection and its
delivery indexes, tolerating concurrent startups. Index failures prevent this
receiver from accepting deliveries; they never trigger deletion or rewriting of
history. Normal API startup also initializes these indexes through the Audit model.

`producer` is a trusted identity from the receiving transport, not a value copied
from an untrusted request body. It must match the validated envelope's producer.
The receiver exposes only an internal function. A later service transport must
authenticate callers before invoking it; validation alone does not authenticate
an event's origin. Live producers use the transactional projection below, while
the independent consumer handles replay/delivery outside producer transactions.

Each accepted event becomes one ordinary audit document with the original
occurrence time, actor snapshot, resource, changes, and request ID. Internal
`_delivery` metadata stores the producer, event ID, stream ID, sequence, and a
SHA-256 fingerprint of the complete canonical envelope. The model excludes this
metadata from queries, preserving the current list/detail HTTP contract.
The fingerprint avoids storing a second copy of personal data in a receipt.

Two partial unique indexes enforce `(producer, eventId)` and
`(producer, streamId, sequence)`. Existing history has no delivery metadata and
is excluded from both indexes. It remains readable, is never matched by guessing
timestamps or content, and is not backfilled by initialization. Keep delivery
identities with their history: removing them would allow replay to duplicate it.
There is no receipt collection, TTL, or in-memory deduplication cache.

One document insert atomically records both history and delivery identity with
`writeConcern: { w: "majority" }`. An identical retry returns
`{ auditId, duplicate: true }` with the original audit ID; a first delivery returns
`duplicate: false`. Concurrent receivers rely on MongoDB's unique indexes. After
a duplicate-key error, the receiver acknowledges only matching history visible
to a majority read on the primary. A duplicate that is not yet majority-visible
remains a storage error for the sender to retry. Lost acknowledgments after a
committed insert are therefore safe to retry.

Reusing an event ID with changed content or metadata throws an
`AUDIT_DELIVERY_CONFLICT` with reason `EVENT_ID_REUSED`; assigning another event
ID to an occupied stream sequence uses reason `STREAM_SEQUENCE_REUSED`.
Neither overwrites history or acknowledges conflicting data. Object key order
and hexadecimal ID case are normalized; change-array order remains part of the
immutable envelope. Schema/validation errors and conflicts require investigation.
Storage failures propagate, and the sender must retain its event until successful
acknowledgment. No independent retry or producer transaction is hidden inside
the consumer.

Streams can arrive out of order or with gaps: this append-only receiver retains
valid history rather than using an arrival-time high-water mark to drop events.
Ordering delivery and diagnosing gaps belong to the later worker/operations
steps. Different producers have independent event identities; anonymous failed
logins retain their event-specific streams.

## Live producer capture and immediate history

Employee and Identity each own an `audit.js` adapter. Employee computes field
diffs from its allowlisted directory snapshots; Identity selects verified public
actor fields and account metadata. Shared actor projection resolves legacy names
and excludes account credentials. Neither adapter forwards request bodies or
whole database documents to Audit. Request bodies cannot supply event IDs,
producer names, sequences, schema versions, or occurrence timestamps.

Each domain's `initialize()` now initializes its outbox after its models.
Startup awaits all domain initialization before listening. Producer factories
are bound to their MongoDB `Db`; reconnecting requires initialization again.
Uninitialized producers reject writes and roll back business changes instead
of creating unindexed collections or using a disconnected client's outbox.
Maintenance imports and migration dry runs still perform no outbox initialization.

Capture runs inside one transaction:

1. Apply the employee/account/session change.
2. Enqueue its safe snapshot and allocate its per-resource sequence.
3. Call Audit's `appendEnvelope(envelope, { producer, session })` to insert
   immediate history with the **same** event ID, occurrence time, sequence,
   producer, and canonical fingerprint.
4. Commit with snapshot isolation and majority write concern, then respond and
   issue/clear any session cookies.

The immediate projection requires an active transaction from Audit's current
MongoClient and shares the consumer's validation/document projection. It never
calls the independent consumer, which would commit outside the producer session.
This transitional path relies on the current shared database/client. Remove it
only in the later asynchronous-activation step before splitting domain storage.

Any business, validation, outbox, or history insertion failure aborts all three
parts, including sequence allocation and session rotation. Employee number
allocation intentionally remains outside the transaction, preserving gaps after
failed creates and preventing number reuse. Hierarchy mutations retain their
shared guard in the same transaction.

`withDomainTransaction` uses Mongoose's transaction retries. A retried callback
rebuilds snapshots and allocations after aborting the previous attempt; only the
committed envelope's identity matters. The same committed envelope is reused for
every delivery retry. Callbacks must not issue cookies or perform external side
effects before commit. Unknown commit results are handled by the driver's commit
retry protocol, not an independent application retry of the business request.

Captured actions are employee create/update/delete and authentication
register/login/failed-login/refresh/logout. Failed login has no business write,
but uses a transaction so its anonymous intent and immediate history remain
atomic. Malformed login data, unknown accounts, and incorrect passwords all take
this path. Denied/invalid employee writes and refresh/logout without a valid
session do not invent successful lifecycle history. Failed authentication storage
returns a server error without issuing cookies, preserving the existing policy
that required audit storage failures prevent completion.

Pending rows remain `PENDING` with zero attempts even though immediate history
exists. Replaying their exact envelopes returns the existing audit ID and creates
no extra history. This step does not mark them delivered or delete them: the later
worker must make that acknowledgment safely. Pending storage therefore grows
until delivery/retention is enabled; no TTL or cleanup may discard undelivered data.

## Verification

Run `npm run test:unit` and `npm run test:integration` from `backend`.
Contract tests cover field allowlists, metadata, actor isolation, anonymous failed
logins, detached snapshots, UTF-8 size limits, and invalid/nested values. Real
MongoDB replica-set tests cover explicit initialization, atomic commit/rollback,
transaction ownership, duplicate IDs, sequence exhaustion, persistence after
reconnecting, producer isolation, and concurrent allocation through two clients.
Consumer tests use independent clients for simultaneous delivery and cover
idempotent retries, immutable-content and stream-sequence conflicts, anonymous
events, source matching, explicit/failed initialization, write failures, lost
acknowledgments, unconfirmed duplicates, and persistence after reconnecting.
API regressions validate that delivered and legacy history keep the same public
response schema without exposing internal delivery metadata.
Live API regressions also compare captured envelopes with immediate history for
all eight actions, replay them without duplication, and verify anonymous login
failures, rollback at either storage boundary, sequence reuse after abort,
transaction retry behavior, post-commit cookies, and reinitialization on reconnect.
