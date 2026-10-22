# Microservices migration

WorkSphere is migrating incrementally from one API. Iterations 2 and 3 progress one
focused pull request per implementation step, using a feature branch instead of
direct pushes to `main`. Each step includes tests and inline comments documenting
the contract, invariants, and failure handling. Later steps build on reviewed,
merged predecessors.

## Iteration 1: domain boundaries and coordination

Implemented in the modular API:

- `backend/src/modules/identity` owns accounts, sessions, authentication, and
  shared authentication request budgets.
- `backend/src/modules/employees` owns employee records, immutable employee
  numbers/counters, validation, and reporting relationships.
- `backend/src/modules/audit` owns persistent audit events and authorized queries.
- Each domain exposes an `index.js` entry point. Production callers import that
  entry point instead of another domain's models or internal implementation.
  A unit check guards this dependency rule. Test and maintenance fixtures can
  access private models to prepare synthetic data.
- Authentication passes a plain identity snapshot to downstream handlers.
- Hierarchy transactions write a common MongoDB guard before checking the graph.
  Conflicts retry with fresh reads across processes; failed operations roll back
  both the guard and domain changes. See [manager relationships](manager-relationships.md).
- Login and registration use one MongoDB-backed request budget across instances.
  Atomic increments use database time; expiration is checked even before TTL
  deletion. Keys hash client addresses. Store errors fail closed.

Public HTTP paths, cookies, authorization rules, employee numbers, and existing
collections remain compatible. This iteration keeps one database connection and
atomic audit insertion while exposing the code boundaries needed for extraction.
No new package or image versions are introduced.

## Iteration 2: durable audit delivery

Deliver durable, versioned audit events through the following PRs:

1. **Event contract and transactional storage** (completed): shared version-1
   event metadata and field allowlists; producer-owned outboxes; transaction-only
   enqueue; per-resource sequences; rollback, validation, and concurrent-writer
   tests. See [the outbox contract](audit-outbox.md).
2. **Idempotent Audit consumer** (completed): strict delivered-envelope validation,
   trusted producer matching, and atomic history/delivery identity storage with
   majority durability. Partial unique indexes deduplicate producer/event IDs and
   protect stream positions without modifying legacy history or the HTTP schema.
   Tests cover concurrent receivers, conflicting/repeated delivery, storage
   failures, lost acknowledgments, and persistence after reconnecting.
3. **Producer integration** (completed): Employee and Identity own safe snapshots
   and capture pending envelopes with employee/account/session changes, including
   anonymous failed logins. One majority-committed transaction also writes immediate
   history from the same envelope. Replay deduplicates against this record. Tests
   cover both storage failures, transaction retries, sequences, cookies, and reconnects.
4. **Delivery worker** (completed): conditional claims, expiring tokens that fence
   stale workers, stream ordering, delivery deadlines, bounded backoff/retries,
   and explicit failed-event replay. Tests cover simultaneous clients and SIGKILL
   before delivery or acknowledgment. See [audit delivery](audit-delivery.md).
5. **Operational visibility and asynchronous activation** (completed): async is
   the default, with an explicit sync rollback mode. Compose deploys the worker;
   server-clock heartbeats and administrator-only delivery health expose backlog,
   failures, blocked streams, and expired leases. The history page polls while
   visible. API and browser regressions stop/restart real workers and prove writes
   continue during outages and history catches up without duplication. Visibility
   targets, retained data, replay, and rollback are documented in the runbook.

The complete iteration must prove that committed changes have durable audit
intent and that retries never lose or duplicate audit history. Pending events
must survive outages; no TTL may silently delete them. Live capture, durable
intent, asynchronous delivery, operational health, and explicit failed-event replay
are available. The synchronous projection remains an explicit rollback mode;
independent Audit deployment is iteration 3.

## Iteration 3: independent Audit service

Extract Audit through the following focused PRs. The storage boundary, private
runtime, and opt-in remote worker delivery are implemented; API query forwarding,
deployment, and retained-history cutover remain separate steps.

1. **Explicit Audit storage boundary** (completed): consumer and query factories
   accept their own native MongoDB database. Shared collection/index definitions
   preserve history and delivery identities. The existing API delegates reads to
   this boundary. Authenticated database tests use Audit-only writer/read-only
   accounts, deny business database access, and verify query/API compatibility,
   private-field projection, reconnects, and replay without a default API connection.
2. **Private Audit HTTP runtime** (completed): independently configured ingestion and
   query endpoints, per-client short-lived signed tokens, producer/role permissions,
   shared database rate limits, health checks, bounded requests, and graceful
   shutdown. Browser cookies and session storage stay at the API boundary. Two
   real HTTP processes prove authenticated isolation, deduplication, shared budgets,
   and restart/replay; production container smoke verifies the standalone entry point.
3. **Remote worker delivery** (this PR): opt-in HTTP delivery signs each request
   with a producer-specific credential, bounds time/response size, rejects redirects,
   and validates acknowledgment identity before settling intent. Receiver retry
   hints feed durable backoff. Scoped database and real-process tests prove outages,
   lost acknowledgments, crashes, and restarts preserve intent and deduplicate
   history without local fallback. Compose remains local until query/history cutover.
4. **Compatible API query forwarding**: retain browser paths and live session/role
   authorization while forwarding authorized reads to Audit. Bound network work,
   sanitize failures, and avoid granting the API access to Audit's private database.
5. **Private datastore and deployment cutover**: deploy Audit with scoped database
   credentials, preserve and verify all legacy history and delivery identities,
   and switch Compose/CI/browser workflows to the independent runtime. Document
   controlled cutover, recovery, and rollback. No step may silently reset history,
   resource sequences, event IDs, or deduplication state.

The iteration is complete after independent ingestion and queries, authenticated
calls, private data access, retained-history migration, and deployment/outage
regressions pass. See [the Audit service boundary](audit-service.md) for the
implemented storage/HTTP contracts and the remaining deployment constraints.

## Iteration 4: independent Identity and Employee services

Planned: separate runtimes, domain database credentials, and deployment/rollback
units. Preserve session revocation and authorization through an explicit identity
contract. Add routing, network deadlines, safe retry behavior, metrics/tracing,
and service compatibility/failure tests before production deployment.

Employee numbers and manager relationships stay within the Employee domain.
Separate physical database servers, Kubernetes, and a message broker are choices
to evaluate against operational needs rather than prerequisites for iteration 1.
