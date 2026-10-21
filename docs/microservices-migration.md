# Microservices migration

WorkSphere is migrating incrementally from one API. Iteration 2 progresses one
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

1. **Event contract and transactional storage** (this step): shared version-1
   event metadata and field allowlists; producer-owned outboxes; transaction-only
   enqueue; per-resource sequences; rollback, validation, and concurrent-writer
   tests. See [the outbox contract](audit-outbox.md). Live APIs still use existing
   transactional audit insertion while this foundation is reviewed.
2. **Idempotent Audit consumer**: validate envelopes and deduplicate by producer
   and event ID, retaining legacy history and testing conflicting/repeated delivery.
3. **Producer integration**: atomically capture outbox events with employee and
   authentication changes, including failed-login events. Preserve immediate
   history through the existing path with matching event identities until workers
   and replay are proven safe.
4. **Delivery worker**: coordinated claims, expiring leases, bounded retries with
   backoff, recovery, replay, and tests for crashes and simultaneous workers.
5. **Operational visibility and asynchronous activation**: expose backlog/failure
   health, define audit visibility delay and retention/replay procedures, and
   enable asynchronous delivery with API/browser outage and recovery regressions.

The complete iteration must prove that committed changes have durable audit
intent and that retries never lose or duplicate audit history. Pending events
must survive outages; no TTL may silently delete them. The current PR supplies
the storage foundation, with producer capture and delivery in subsequent PRs.

## Iteration 3: independent Audit service

Planned: deploy audit ingestion/query handling independently with private data
access, authenticated service calls, health checks, and retained history. Verify
recovery after outages and compatibility with the existing browser API.

## Iteration 4: independent Identity and Employee services

Planned: separate runtimes, domain database credentials, and deployment/rollback
units. Preserve session revocation and authorization through an explicit identity
contract. Add routing, network deadlines, safe retry behavior, metrics/tracing,
and service compatibility/failure tests before production deployment.

Employee numbers and manager relationships stay within the Employee domain.
Separate physical database servers, Kubernetes, and a message broker are choices
to evaluate against operational needs rather than prerequisites for iteration 1.
