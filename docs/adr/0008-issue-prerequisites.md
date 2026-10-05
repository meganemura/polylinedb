# Separate prerequisite aggregates

## Decision

Store dependent-to-blocker edges separately from issue fields.
Each issue has a positive aggregate revision. Each successful mutation retains an immutable UUID receipt with its actor and timestamp.
Existing issue field CAS and creation receipts retain their formats.

The first statement admits a fresh receipt only when both endpoints and the exact expected revision pass.
An existing UUID attempts the same primary key before any graph mutation, regardless of its supplied revision.
That failure resolves the committed receipt by actor and canonical payload.
A fresh accepted request advances the aggregate once, including an edge no-op.
Receipt outcomes describe their historical mutation rather than the current graph.

A recursive insertion trigger rejects cycles across different aggregates. Endpoint update triggers preserve edge identity.
The batch owns admission, revision change, edge change, and diagnostic observations.
A failed statement rolls back all writes.

Readiness joins edges with current blocker statuses. It has no persisted cache.
Status CAS rejects a requested start or close when active blockers exist.
A forced exception requires a reason comment gated on the immediately successful status write.
Reopen and prerequisite edits can activate blockers without changing a dependent's stored status.

## Alternatives

A dependency field inside Issue would change every projection, field registry, and historical creation decoder.
A separate aggregate limits those compatibility changes and supports independent graph CAS.
An application-only cycle check can race across dependents. The database trigger validates their shared graph inside the transaction.
Returning a current graph on replay would obscure the original result.
Persisted receipts return the historical outcome without executing another graph mutation.

## Persistence

Canonical schemas 2, 3, and 4 upgrade additively to schema 5.
Snapshot 4 contains separate edge, revision, and request collections.
Explicit older snapshot conversions seed empty graphs at revision 1 and preserve existing request payload strings.
Restore and additive transfer include every graph collection in their digests and equality checks.
Edge pages use numeric ID tuples. Claimed partial restores permit trigger-created baseline revisions before restoring exact revisions.
Retired historical stores reject upgrades and retain their guards. Read-only historical export creates a recoverable snapshot without schema writes.

## Verification

Real SQLite and local workerd D1 tests exercise concurrent edges, aggregate conflicts, duplicate UUIDs, replay, status policy, and rollback.
Snapshot tests preserve request bytes, actor attribution, graph rows, and canonical DDL across historical upgrades and interrupted transfers.
Production migration and deployment require separate operator approval and verification.
