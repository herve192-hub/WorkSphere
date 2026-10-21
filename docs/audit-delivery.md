# Audit delivery worker and recovery

Iteration 2, step 4 adds a separately invoked worker. Employee and Identity still
commit immediate audit history with their business changes and outbox envelopes.
The worker acknowledges those envelopes through the idempotent Audit consumer.
It does not change HTTP routes, cookies, audit visibility, or API startup.

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

The API image includes these commands but intentionally excludes npm/npx. In a
running Compose environment, launch a separate worker container with:

```sh
docker compose run --rm --no-deps api node scripts/audit-worker.js
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
backlogs still require capacity/latency monitoring in the next operations step.

A conditional atomic update grants a fresh UUID lease token and marks `IN_FLIGHT`.
MongoDB `$$NOW` sets/checks deadlines, so application clock skew cannot prematurely
expire another worker's lease. Claims and state transitions use majority write
concern; candidate reads use majority visibility on the primary. Each delivery
claim consumes one attempt, including a crash before the receiver call.

Acknowledgment and failure updates require the same token and an unexpired lease.
A stale worker returns `LEASE_LOST` and cannot acknowledge, reschedule, or fail
another worker's event. An expired lease can be reclaimed. There is no heartbeat:
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
`deliveredAt`/`auditId`. Tokens are removed on successful settlement. No state has
a TTL and no delivered or failed envelope is automatically deleted.

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

Merge/review this worker step after producer integration. Deployment scheduling,
backlog/failure health, retention/replay policy, and asynchronous activation with
browser outage/recovery checks are iteration 2, step 5.
