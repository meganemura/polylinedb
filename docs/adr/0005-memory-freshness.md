# Project memory observations

Status: accepted.

A session can keep valid issue field versions after another actor changes its project knowledge.
Use a durable project revision and a store incarnation to detect these changes.
A context observation covers the project, including entries excluded by retrieval limits.
Revision equality means that the project accepted no memory mutation since the observation.
It does not prove that the session retrieved all entries.
A create followed by deletion changes the revision, even when the project becomes empty again.

Callers request `memory_context` with `with_revision: true` and retain its opaque `memory_revision` token.
Ordinary issue operations accept `observed_memory_revision` and return `memory_freshness` only with that argument.
The CLI exposes `--with-revision` and `--observed-memory-revision TOKEN`.
The token encodes a format version, store incarnation, project, and safe integer revision.
It is an observation, not a credential.
Requests without these options retain their existing result fields.

Memory insert, accepted update, and delete triggers increment the project revision within the mutation transaction.
An accepted replacement with unchanged text still increments the revision.
Creation replay and rejected version writes leave it unchanged.
A trigger rejects changes to a memory ID or project, matching the domain's fixed identity rule.
A named counter constraint rejects exhaustion and rolls back the memory write.
Projects retain revision rows after their final memory disappears.

Context retrieves identity, revision, and page in one batch.
The byte limit includes the token.
Callers can combine pages when their tokens match, while retaining omission notices.
A different token requires a new traversal.
The advisory compares identity and revision in one query after the issue operation succeeds.
A later memory mutation can occur after this sample.
The advisory does not lock issue writes.
A failed advisory returns `unavailable` and preserves the completed issue result.
Operation errors retain their existing error shape.

Create uses its resulting issue project.
Show, update, close, and reopen use their resulting issue project.
Comment samples the issue project after the comment completes.
A concurrent project change can therefore make the comment advisory refer to the new project.
List and search use an explicit project filter when supplied.
An unfiltered list or search checks the token's project, even when its results contain other projects.
The `project` field in each advisory identifies this scope.
A project mismatch reports `project_changed`; a store mismatch reports `store_changed`.
The executor removes the observation before issue domain parsing and execution.
Creation receipts and snapshot payloads keep their canonical operation representation.

Schema 4 adds operational identity and revision tables.
Explicit upgrades accept canonical schemas 2 and 3 and perform all steps in one transaction.
An existing memory project starts at revision 1.
Portable snapshots retain format version 3 and their existing content fields.
A new import has a fresh store incarnation; an identical import keeps its incarnation.
D1 migration SQL follows the same trigger and seed rules.

## Raw database restore

A raw database backup includes the incarnation and revisions.
Restoring it can reproduce a previously issued token.
The operator must stop every writer and reader before a raw restore.
For local stores, close all CLI and library connections before replacing the database file.
For D1, disable request traffic and stop maintenance writers before the supported D1 restore operation.
After restore, execute this statement against the restored database before resuming service:

```sql
UPDATE memory_store_identity SET incarnation = lower(hex(randomblob(16))) WHERE singleton = 1;
```

Check that the table contains exactly one row with a 32-character lowercase hexadecimal incarnation.
Then reopen connections or restore request traffic.
Tests demonstrate token replay without rotation and a stale result after rotation at the same database path.
A new incarnation prevents revision reuse across restored stores.
The application cannot detect an external rollback that also restores its identity.
Local D1 tests establish adapter behavior; they do not establish a production restore procedure.

## Alternatives

A canonical project digest scans all memory bodies on each observed issue operation.
It also considers a restored prior state equal, while the revision contract records accepted mutations.
A list of entry versions exposes pagination and deletion detection to every caller.
A maximum timestamp loses evidence when a memory disappears and depends on clock order.
The durable project revision provides one indexed lookup and retains deletion evidence.
