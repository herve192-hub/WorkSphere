# Audit delivery worker and recovery

Iteration 2 now defaults to asynchronous delivery. Employee and Identity commit
business changes and outbox envelopes together; the worker writes history later
through the idempotent Audit consumer. Receiver outages defer visibility while
business writes continue. Outbox failures still roll back business changes before
cookies are issued. `AUDIT_DELIVERY_MODE=sync` is an explicit rollback mode that
also projects immediate history using the same event identities.

## Run the worker

From `backend`, with the existing replica-set/sharded-cluster `MONGO_URI`:

```sh
npm run audit:worker
npm run audit:worker -- --once
```

The continuous command processes one event from each producer per pass, polling
every second when idle and yielding between busy passes. `--once` performs at most
one attempt per producer and exits. It is a bounded operational check, not a full
backlog drain. Idle means no eligible stream head; backoff, active leases, and failed
heads may still exist. A retry/failure/lost lease or storage error makes `--once`
exit nonzero. The continuous worker keeps serving other streams and logs the result.

`docker compose up --build` now starts a dedicated `audit-worker` service using
the same pinned backend image, database URI, and non-root runtime. It depends only
on MongoDB health, restarts unless explicitly stopped, and has a 20-second shutdown
grace period. It receives no API JWT secret or published HTTP port. Check it with:

```sh
docker compose exec audit-worker node scripts/audit-status.js --check
```

The worker owns its MongoClient, verifies the topology, and explicitly initializes
the producer outboxes and consumer indexes. It needs database access, not a JWT
signing secret or an HTTP listener. The current executable uses the local Audit
consumer as its trusted transport. When Audit becomes a separate service, inject
an authenticated transport that preserves the same acknowledgment contract.
Run multiple worker processes against the same producer database to share work.

SIGINT/SIGTERM stops claiming new work, wakes an idle poll, waits for the active
attempt, and closes the client. A 15-second shutdown deadline terminates a stuck
process; its unacknowledged lease remains recoverable. Driver connection/selection
timeouts are 5 seconds and socket timeout is 10 seconds. No raw database or
transport error messages are printed: they may contain credentials or request data.

## Claims, stream ordering, and leases

`createAuditWorker(db, producer, deliver, options?)` is exported from `src/outbox`.
Importing or constructing it performs no writes and starts no timers. Await
`initialize()` before `deliverNext()` or `replay(eventId)`. `deliverNext()` makes
at most one delivery attempt and returns its status and event ID, or `IDLE`.

The worker first selects the earliest retained non-delivered event in each stream.
Only then does it test readiness. A future retry time, active lease, or `FAILED`
head blocks later events in that stream, while unrelated streams remain eligible.
There is no ordering across resources or producers. Sequence counters and original
envelopes remain unchanged. The ordered scan uses the unique stream/sequence index,
projects away event snapshots before grouping, allows disk spill, and has a
five-second server deadline. It considers up to 32 eligible heads per call; large
backlogs require capacity/latency monitoring; health queries also have a five-second
server deadline. Scale workers and database capacity before that deadline is reached.

A conditional atomic update grants a fresh UUID lease token and marks `IN_FLIGHT`.
MongoDB `$$NOW` sets/checks deadlines, so application clock skew cannot prematurely
expire another worker's lease. Claims and state transitions use majority write
concern; candidate reads use majority visibility on the primary. Each delivery
claim consumes one attempt, including a crash before the receiver call.

Acknowledgment and failure updates require the same token and an unexpired lease.
A stale worker returns `LEASE_LOST` and cannot acknowledge, reschedule, or fail
another worker's event. An expired lease can be reclaimed. Leases are not renewed:
normal delivery has a shorter deadline than the lease; a stalled process can lose
ownership and must tolerate redelivery. A crash on the final allowed attempt
becomes `FAILED` after expiry without making an extra receiver call.

## Delivery and retry policy

All workers for a producer should use the same policy. The executable uses these
defaults; the factory accepts validated integer options for embedding/tests:

| Option | Default | Meaning |
| --- | --- | --- |
| `maxAttempts` | `5` | Claims per delivery/replay round, maximum `100` |
| `leaseMs` | `30000` | Claim duration, maximum one hour |
| `deliveryTimeoutMs` | `10000` | Receiver deadline; must be shorter than the lease |
| `retryBaseMs` | `1000` | Initial retry delay |
| `retryMaxMs` | `60000` | Exponential-backoff cap, maximum one day |

The transport receives a detached, validated envelope plus trusted `producer` and
an AbortSignal. It must acknowledge durable history as `{ auditId, duplicate }`,
where the ID is a lowercase ObjectId string and duplicate is boolean. Success
marks `DELIVERED` with that audit ID and server timestamp. The receiver must
deduplicate immutable producer/event IDs; lease fencing alone cannot prevent
external effects from a late receiver call.

A deadline aborts the transport signal, but cancellation is never proof that no
history was inserted. A late completion, crash after insertion, lost acknowledgment,
or unknown outbox-update outcome all recover by redelivering the **same** envelope.
The consumer returns the original audit ID without adding history. No receiver
call runs inside a database transaction.

Transient delivery errors and invalid acknowledgments return to `PENDING` with
`base * 2^(attempts-1)` backoff capped at `retryMaxMs`. Exhaustion marks `FAILED`.
An invalid stored envelope or consumer conflict marks `FAILED` immediately.
Storage errors propagate without trying a second state update: the first update
may already have committed. Raw exception messages are never retained. Stored
failure codes are `INVALID_EVENT`, `DELIVERY_CONFLICT`, `DELIVERY_TIMEOUT`,
`DELIVERY_FAILED`, `INVALID_ACKNOWLEDGMENT`, or `ATTEMPTS_EXHAUSTED`.

Delivery metadata includes current-round `attempts`, lifetime `totalAttempts`,
`lastAttemptAt`, `lastFailureAt`, `lastErrorCode`, terminal `failedAt`, and successful
`deliveredAt`/`auditId`. Tokens are removed on successful settlement. Envelopes have
no TTL and no delivered or failed envelope is automatically deleted.

## Replay a failed event

Investigate its failure code and restore the receiver or deploy the reviewed
contract fix first. Reset exactly one event with an explicit producer, UUID, and
apply flag; no employee data or payload file is accepted:

```sh
npm run audit:replay -- --producer employees --event-id 00000000-0000-4000-8000-000000000001 --apply
```

The UUID above is synthetic. Without `--apply`, help/invalid arguments do not
connect or change data. `replay` atomically changes only `FAILED` to `PENDING`,
resets current-round attempts, and increments `replayCount`/`replayedAt`. It
preserves the envelope, sequence, lifetime attempts, and failure details. It does
not deliver immediately. Concurrent replay requests can reset a failed round only
once; pending, active, delivered, and missing events return `replayed: false` and
the command exits nonzero. Stop and investigate persistent conflicts rather than
editing envelopes, skipping failed heads, deleting history, or resetting counters.

## Visibility and operational health

The normal-operation visibility target is **10 seconds** from committed business
change to queryable history. This is an operational target, not a transaction or
outage-time guarantee. A stopped receiver/worker or failed stream head can defer
visibility until recovery/replay. Reads contain delivered history only. The browser
polls every five seconds while the history page is visible, avoids overlapping
reads, and preserves rows/expanded details during background refresh or read failure.

Use `GET /api/v1/operations/audit` with an ADMIN session, or run from `backend`:

```sh
npm run audit:status
npm run audit:status -- --check
```

The command performs no initialization or writes and needs no API signing secret.
The endpoint is ADMIN-only and sends `Cache-Control: no-store`. Both expose aggregate
pending/in-flight/failed/delivered/unknown counts, blocked streams, expired leases,
oldest outstanding age, and active-worker counts per producer. They return no
employee, event, request, lease-token, or worker IDs and no raw failure messages.
The `mode` field identifies the responding process's configuration; use the API
endpoint to inspect API mode during a rolling deployment.

The HTTP endpoint permits **100 requests per IP per 15 minutes**, shared across all
API replicas and separate from register/login limits. Every attempt counts,
including denied and degraded responses. Rate limiting runs before session lookups
and health queries; if its MongoDB store fails, the request stops with a sanitized
HTTP 500. Exhausted budgets return HTTP 429 with `Retry-After`, `RateLimit`, and
`RateLimit-Policy` headers. Honor `Retry-After` and coordinate monitors behind the
same IP; a ten-second polling interval uses 90 requests per window. Client addresses
are hashed in storage. The CLI and Compose worker checks do not use this HTTP budget.

Workers publish server-clock heartbeats every five seconds to producer-owned
`employee_audit_workers` / `identity_audit_workers`. A running heartbeat older than
30 seconds is stale, independent of TTL cleanup. Graceful shutdown marks only that
process stopped; multiple workers have independent anonymous IDs. Heartbeat
metadata expires after one day. This TTL never applies to envelopes, counters,
history, or deduplication identities.

Missing/stale workers, failed events, expired leases, unknown states, or oldest
outstanding age over ten seconds produce `DEGRADED` (HTTP 503 / `--check` exit 1).
Initial queue creation/readiness timestamps come from MongoDB during sequence
allocation, so producer clock skew cannot delay eligibility or hide backlog age.
Outstanding age includes time between allocation and transaction commit; the
visibility target starts at commit. This makes the age signal conservative for
unusually slow transactions. Occurrence timestamps remain the producer's snapshot.
An available status command without `--check` exits successfully even when degraded
so operators can inspect its JSON. Database/query failure exits nonzero and the
HTTP endpoint returns a sanitized server error. `/health/ready` continues to measure
API/MongoDB readiness; delivery health never rejects otherwise valid business writes.
Compose checks worker delivery health every ten seconds with three retries.
Monitor both delivery health and API readiness; investigate sustained lag/failures
and scale capacity rather than treating HTTP process liveness as audit delivery.

## Outage, rollback, and retention policy

1. Start/upgrade the worker with the reviewed producer/consumer contract. Verify
   active heartbeats and inspect backlog/failures before and after deployment.
2. If the worker stops, restart it. Expired claims recover automatically; history
   insertion and unknown acknowledgments are deduplicated. For `FAILED` heads,
   investigate the safe failure code, restore the dependency, and explicitly replay
   the affected event as described above. Later events in that stream remain blocked.
3. To restore immediate visibility, set `AUDIT_DELIVERY_MODE=sync` in API process
   configuration (`backend/.env` for local Compose) and restart/recreate API instances.
   With Compose, recreate the API to reload its environment file:
   `docker compose up --detach --no-deps --force-recreate api`.
   Keep the worker running to drain older intent. Rolling async/sync instances are
   safe because both paths reuse event IDs. The rollback path requires history
   storage to be available and again fails writes if immediate insertion fails.
   Clearing the override returns to async; invalid/empty mode values fail API startup.
4. **Retain all pending, in-flight, failed, and delivered envelopes, sequence counters,
   audit history, and delivery identities indefinitely in this implementation.** No
   automatic deletion, TTL, or bulk requeue touches them. This conservative policy
   preserves recovery and replay until a separately reviewed organizational retention
   policy exists. Monitor disk/backlog growth and protect database backups/access as
   personal data; never export them into Git. Any future delivered-envelope cleanup
   must verify durable matching history first and preserve sequence counters and
   deduplication identities. Deleting history/identities can make replay duplicate it.

API integration tests exercise receiver and outbox failures, real worker restarts,
health access/staleness, and sync rollback. Playwright stops only the disposable
verification stack's worker, performs business writes, restarts it, and observes
automatic UI recovery with exactly one event per action in all three browsers.
