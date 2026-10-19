# Microservices migration

WorkSphere is migrating incrementally from one API. Each iteration gets one
commit and one push after its checks pass. New behavior includes inline comments
that document the contract, invariants, and failure handling.

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

Planned: save a redacted, versioned event to an outbox in the same transaction as
each business change. Add a delivery worker with retries and consumer deduplication.
Test rollback, crashes, service outages, repeated delivery, and event ordering.
Define the resulting audit query visibility delay explicitly.

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
