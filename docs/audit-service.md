# Independent Audit service: storage boundary

Iteration 3 starts with the database boundary used by the future Audit runtime.
This first PR keeps the deployed API/worker arrangement while allowing Audit
ingestion and queries to use a separately supplied database and credentials.
The remaining PRs are tracked in [the migration plan](microservices-migration.md).

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
The factories themselves expose no network listener.

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
cross-service atomic rollback path. A later remote cutover must define and enforce
supported modes before removing the monolith's Audit database access.
