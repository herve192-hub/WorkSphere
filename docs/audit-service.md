# Independent Audit service

Iteration 3 provides an explicit Audit database boundary and an independently
runnable private HTTP service. The worker supports opt-in authenticated HTTP
delivery; existing Compose deployment and API reads still use local adapters.
Query forwarding and deployment/history cutover follow in
[the migration plan](microservices-migration.md).

## Start and configure the private runtime

After `npm ci` in `backend/`, select the repository's `.nvmrc` runtime, supply the
Audit configuration, and run:

```sh
cd backend
npm run audit:service
```

The production API image also contains this entry point and its production
dependencies. Start it with `node scripts/audit-service.js`; npm is deliberately
absent from the final image. This PR tests that command inside the disposable
container stack but does not yet add a deployed Compose Audit service.

| Variable | Contract |
| --- | --- |
| `AUDIT_MONGO_URI` | Required MongoDB URI selecting Audit's database; there is no fallback to `MONGO_URI`. Use a replica set or sharded cluster and credentials scoped to the Audit database. |
| `AUDIT_SERVICE_KEYS` | Required JSON object containing exactly `employees`, `identity`, and `api` secrets. Each must contain at least 32 bytes; use independently generated random values. Duplicate values, template placeholders, and reuse of a supplied `JWT_ACCESS_SECRET` are rejected. |
| `AUDIT_HOST` | Literal bind IP, default `127.0.0.1`. Bind a container interface only within a private deployment network. |
| `AUDIT_PORT` | Default `5001`; port `0` selects an ephemeral port for isolated tests. The ready log includes the actual port. |

`backend/.env.example` contains only placeholders and local URLs. Inject real
credentials at runtime; never commit them. The service needs no browser signing
secret, business database access, account/session lookup, or default API connection.
Startup initializes Audit history/indexes and the `audit_request_budgets`
collection before listening. A scoped `readWrite` role on the Audit database
supports this initialization and request accounting. Audit history never expires;
only request counters have a TTL index.

Keep this listener private and protect service traffic with TLS at the deployment
boundary. Service bearer tokens are credentials and must not enter browser code.
Provide each caller only its own secret; Audit verifies all three. Rotation
currently requires coordinated configuration/restarts: this contract does not
support overlapping old/new keys.

## Authentication and HTTP contract

Every internal request requires `Authorization: Bearer <JWT>`. Tokens must use
`HS256`, issuer `worksphere-internal`, audience `worksphere-audit`, and a subject
matching one configured client. Explicit integer `iat` and `exp` claims are
required, with `0 < exp - iat <= 60` seconds. Expired, future-issued, unsigned, or
wrong-algorithm tokens are rejected. Keep caller/receiver clocks synchronized;
there is no clock-skew tolerance. Decoding chooses a candidate key only; verified
claims determine permissions.

- `employees` and `identity` may ingest only envelopes matching their verified
  subject. Supplying a different body producer cannot impersonate that producer.
- `api` may query only with a signed canonical ObjectId `actorId` and an `ADMIN`
  or `HR_MANAGER` role. The API must validate the live browser session and current
  role before minting this short-lived assertion. Producer tokens cannot gain
  query permission by adding role claims.
- Browser cookies grant no access. The private service issues no cookies and
  exposes no cross-origin browser access.

| Operation | Behavior |
| --- | --- |
| `GET /health/live` | Unauthenticated process liveness; `200` while the listener is available. |
| `GET /health/ready` | `200` only after initialization, with a reachable database, while accepting work; otherwise `503`. |
| `POST /internal/v1/events` | One uncompressed JSON version-1 envelope, maximum 64 KiB. `201` follows a new majority write; an identical retry returns `200` with the original history ID. |
| `GET /internal/v1/events` | Same validated filters, ordering, pagination, and public history fields as `/api/v1/audit`. |
| `GET /internal/v1/events/:id` | Same public event shape as `/api/v1/audit/:id`; missing history returns `404`. |

Successful ingestion returns a `data` object with `eventId`, `producer`,
`auditId`, and `duplicate`.
An event-ID or stream-position conflict returns `409` without overwriting history.
Invalid input returns `400`, missing/invalid credentials `401`, denied permissions
`403`, oversized JSON `413`, and compressed requests `415`. Storage failures and
draining return a sanitized `503` with `Retry-After: 1`. A lost response or timeout
is an unknown outcome: retain the original envelope and retry with the same
event ID, producer, sequence, and content. Never infer delivery from a failed call.

The private OpenAPI contract is `backend/src/audit-service/openapi.js`.
`npm run openapi:check` in `backend/` validates it alongside the browser contract;
the private runtime does not publish Swagger or the document over HTTP.

The worker's HTTP transport validates the complete acknowledgment against its
original producer/event ID and accepts only a new `201` (`duplicate: false`) or
an existing `200` (`duplicate: true`). It never follows redirects or creates local
history on a failed remote call. See [worker configuration and recovery](audit-delivery.md#remote-http-delivery)
for credentials, deadlines, retry hints, and the opt-in rollout constraint.

## Request limits and shutdown

MongoDB-backed budgets are shared across service processes: 1,200 requests per
minute per socket IP before authentication, then 600 per authenticated producer
for ingestion or 120 for API queries. The two producer budgets and the API query
budget are separate; all pass through the shared ingress budget. Authorized
attempts count even if later validation fails. Keys are hashed; expiration uses
database time and is enforced before TTL cleanup. Exhaustion returns `429` with
`Retry-After`; unavailable counter storage fails closed with `503` before
authentication, parsing, or history access. The service does not trust forwarded
IP headers. Account for shared proxy addresses when sizing a private deployment.

Health endpoints share a separate process-local budget of 120 requests per minute
per IP. This keeps liveness available when database-backed accounting fails and
bounds readiness pings without writing counters to MongoDB.

The listener allows five seconds for headers and ten for the complete request,
checking incomplete requests every second. Socket inactivity is limited to ten
seconds; keep-alive uses a five-second timeout plus Node's default buffer. These
transport limits do not cancel database writes or prove an event was rejected.
On SIGTERM/SIGINT, the process stops admitting work, drains active requests for
up to ten seconds, closes remaining sockets, and closes its owned database client.
The CLI has a 15-second shutdown deadline. Retry unknown outcomes unchanged.
Logs contain correlation IDs, static operation names, timing, status, and verified
client names; they exclude raw URLs/query values, event bodies, tokens, and raw
database errors.

## Factory contracts

The public `backend/src/modules/audit` entry point exports:

- `createAuditConsumer(db)`: initialize explicitly before consuming trusted,
  versioned envelopes. Initialization creates only `auditevents` and its indexes.
  Consumption retains its majority-write, immutable identity, and deduplication
  contract. See [the outbox contract](audit-outbox.md).
- `createAuditReader(db)`: `listEvents(query)` and `getEvent(id)` return the existing
  audit API data shape, using only the supplied database's `auditevents` collection.
  Construction and reads never create collections or indexes. Reads work with a
  read-only database account; no API signing secret, account/session collection,
  producer outbox, or default Mongoose connection is required.

These factories own no connection or process lifecycle. The caller opens/closes
its client, initializes ingestion before accepting deliveries, and authenticates
and authorizes every request. A supplied producer identity must come from trusted
code or an authenticated transport, rather than an unverified request body.
The factories themselves expose no network listener; the private runtime supplies
authentication, authorization, request accounting, and connection lifecycle.

The existing monolith selects its current database only in Audit's `service.js`
adapter. It creates readers per call so a reconnect cannot retain an obsolete
database handle. Browser paths, cookie/session authorization, response schemas,
and explicit synchronous rollback mode continue through their existing boundaries.

## Query and storage invariants

Collection names and all six application indexes are shared by native Audit
initialization and the compatibility Mongoose model. Existing index names, partial
delivery uniqueness, event IDs, history IDs, sequences, and fingerprints remain
stable. Initialization is repeatable and never deletes legacy records or resolves
corrupt duplicate identities by deleting history. No index expires audit history.

Queries validate their allowlisted string parameters before database access.
ObjectId filters are explicitly cast for the native driver. Search remains a
literal case-insensitive substring, date-only end bounds include the whole UTC
day, and pagination sorts by occurrence time and then descending history ID.
An explicit projection exposes only public event/snapshot/change fields, hiding
delivery metadata and other internal fields, including nested fields.

Reads use the primary with majority read concern and a five-second server deadline
per operation. Listing and counting are separate reads; concurrent delivery may
change the count between them. They do not promise a cross-request snapshot.
Storage errors propagate; a failed or closed Audit client never falls back to
business storage or returns a fabricated empty history.

## Isolation evidence and later cutover

`backend/tests/audit-http.test.js` launches two real service processes against an
authenticated disposable Audit database with randomly generated credentials. It
checks token validation, permissions, producer binding, concurrent deduplication,
shared budgets, read compatibility/private-field hiding, unavailable storage,
bounded incomplete headers, sanitized failures/logs, and graceful restart/replay.
MongoDB denies the service account access to the separate business database, and
the default API connection stays disconnected. Production container smoke also
launches the CLI without an API signing secret and checks readiness, auth, private
queries, idempotent delivery, and SIGTERM using production dependencies only.

`backend/tests/audit-storage-boundary.test.js` starts an authenticated disposable
replica set with separate business/Audit databases and random per-run credentials.
Its Audit writer has `readWrite` on the Audit database, and its reader has `read`
there. MongoDB denies both accounts access to business accounts, sessions,
employees, outboxes, and history; the reader cannot write Audit history. Tests also
check legacy/anonymous events, query contracts, hidden fields, and replay after
reconnecting while the API's default connection stays disconnected. CI discovers
the test automatically in the integration suite. No credentials or exports enter Git.

Production datastore separation remains a later PR. Existing history and its
delivery metadata must move together under a verified cutover plan before query
traffic switches. Event counts alone are insufficient: preserve history IDs,
fingerprints, delivery identities, and legacy records, and verify safe replay.
Producer outboxes and sequence counters stay with their business domains.

`AUDIT_DELIVERY_MODE=sync` still requires one client/transaction for business state,
outbox intent, and immediate history. It cannot serve as a cross-database or
cross-service atomic rollback path. HTTP worker configuration therefore requires
`AUDIT_DELIVERY_MODE=async`; keep the API in async mode as well during a remote
rollout. Production cutover still needs query forwarding and verified history
migration before removing the monolith's Audit database access.
