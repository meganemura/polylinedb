# Add once to an unchanged restored D1 store

Status: Proposed. The four-column and two-column routes have a tested operator library, and no command runs it yet.

## Problem

The additive operator expects canonical schema 6 and rejects `polylinedb_snapshot_claim` before it plans a transfer.
The restore checkpoint identifies the original input, but its presence does not establish completed restoration.
A SQLite interruption before the first issue insertion leaves a valid checkpoint and the chosen destination identity.
Later application edits retain the checkpoint SHA, while verification against the original snapshot rejects the changed rows.
These observations establish the current ambiguity, rather than support for a new D1 route.

## Decision and caller contract

Propose one addition of disjoint local records immediately after restoration, while destination rows exactly match the original input.
One lifecycle owner exposes `run` and `resume` with validated domain arguments and outcomes.
The caller supplies the original restore file, the source, the destination, and one private journal directory.
Preparation, commit, recovery, and finish remain private methods.
The public API does not expose raw queries or checkpoint layouts.
This ADR defines implementation conditions, rather than a CLI procedure.
Current refusal remains until every implementation gate below passes.
The proposal changes neither application schema 6 semantics nor the Worker runtime.

## Original input and destination authority

The schema profile recognizes exact checkpoint DDL and raw rows for two layouts.
Release 0.1.0 uses `singleton` and `sha256`, with snapshot format 3.
The current layout adds `original_incarnation` and `incarnation`, with snapshot format 5.
Preserve the raw DDL, raw row, and layout discriminator for either layout.
For four columns, `original_incarnation` identifies the destination before restoration, rather than the input source.
Require valid, distinct 32-hex incarnation values and destination identity equal to the checkpoint target.
For two columns, preserve the absence of incarnation provenance and capture the current destination identity independently.
Validate exactly one checkpoint with singleton 1, its lowercase 64-hex SHA, and the canonical schema 6 metadata.
Capture all schema entries, application rows, revisions, and authoritative destination identity through a consistent read.
Compare schema entries with canonical schema 6 plus the exact recognized operator layout, using the existing explicit D1 system exclusions.
Unknown DDL and unsupported input versions cause refusal.
The implementation must never choose a snapshot codec from checkpoint columns alone.

Verify the checkpoint SHA against the original input's version-specific canonical digest before any conversion.
Keep original-input, current-baseline, and frozen-operation digests as separate domain types.
Compare every projected application row, key, and count with the destination.
The historical snapshot 3 branch requires a validated deterministic projection into schema 6, including later collections and metadata.
Release 0.1.0 restores snapshot 3 into schema 3 only, so a two-column store reaches schema 6 through the schema 3 upgrade.
The upgrade leaves the 12 application tables equal to `convertSnapshotV3` of the original input.
That result has dependency revision 1 for each issue, no dependency edges, and no claims.
The upgrade seeds project memory revision 1 for each project, but a memory insert after the upgrade increments it.
The two-column checkpoint holds the digest of the snapshot 3 canonical form, which `canonicalSnapshotV3` reproduces.
The snapshot 5 form of the converted input has a different digest.
Do not guess revision values or substitute snapshot 5 canonicalization for the original digest.
Exact equality establishes complete input data now, rather than the historical time at which a restore job finished.
A partial restore, missing original file, changed live state, or new active destination claims cause refusal under this contract.
An empty original input still requires the same checks and atomic barrier.
An exact state reached after earlier edits satisfies equality only when the atomic barrier also passes.

Destination incarnation remains unchanged throughout addition.
Imported source claim incarnations remain history under the existing authority rules.
Preserving existing accepted owners does not promise admission of newly activated destination claims under the original-input equality condition.
Require different source and destination incarnations and the existing namespace, key, counter, claim, and receipt collision checks.

## Atomic addition and checkpoint barrier

One D1 commit batch guards the captured schema, schema version, checkpoint DDL and row, identity, and all 14 captured table ranges.
Guards cover empty and trailing ranges, and claim validity uses the existing rules at commit time.
The same batch adds source rows, updates existing project revisions, and records an immutable operation receipt.
It renames the checkpoint table to `polylinedb_snapshot_claim_archive`, preserving its raw provenance.
It creates a read-only view at `polylinedb_snapshot_claim` with the same visible columns and an always-empty `WHERE 0` selection.
The receipt binds operation identity, frozen-input digest, destination identity, checkpoint layout, original digest, baseline digest, expected result, and counts.
The operator schema profile validates the archive, view, and receipt DDL during recovery.
Any guard failure or statement error must roll back the entire batch.
If the complete batch exceeds D1 limits, preparation refuses instead of splitting the barrier and addition across requests.

Both inspected restore versions use checkpoint `EXISTS` predicates in application `INSERT SELECT` statements.
The proposed empty view makes those statements select zero rows.
The current identity update selects no matching checkpoint, and checkpoint insertion fails against the read-only view.
Minimal SQLite and local workerd D1 probes retain the archived row and make the old predicate select zero rows.
A SQLite statement prepared before the schema change also performs zero writes after the barrier.
The local D1 probe rolls back the rename, view, and added data when a later statement fails.
These probes use a small two-column checkpoint and one application table.
They do not establish safety for both complete restore implementations, all guarded tables, queued requests, or production D1.
The commit must exclude interleaving between the first guard and the archive transition.
Stopping domain writers and stopping restore jobs are separate prerequisites, and neither proves that guarantee.
The terminal layout permits recovery of the recorded addition but refuses a second new addition.
Removing the barrier or restoring again requires a separate explicit destructive recovery decision.

## Durable recovery and transfer order

Before dispatch, durably save the original file, version, canonical digest, source and destination rows, metadata, planned packet, and operation identity.
The private journal records each lifecycle boundary and retains the frozen source through uncertainty.
Recovery never refreshes captured revisions, overwrites conflicts, or allocates a new operation identity.
A matching receipt with consistent terminal metadata confirms commit, even when later legitimate edits change the live digest.
Such edits can block source retirement or routing verification without changing the committed outcome to failed.
An absent receipt with the exact unchanged preimage permits retry of the same packet.
Changed evidence causes refusal, and unavailable or contradictory evidence leaves the outcome unknown.
After confirmed commit, verify the complete result and the exact frozen source before committing source retirement.
Only then change routing, with each completed step recorded for idempotent crash recovery.

## Tradeoffs and implementation gates

Requiring the original file and unchanged rows limits eligible destinations but gives a bounded proof without a reusable restore completion ledger.
Permanent archival preserves provenance and fences inspected old SQL, at the cost of one addition per restored destination.
A permit protocol across all domain writers expands this limited operator change into a broader runtime redesign, so this proposal rejects that alternative.
Adopting an edited baseline requires separate approval and cannot certify original restore completion.

Implementation requires actual D1 tests for atomic DDL, prepared statements created before DDL, and queued SQL from both inspected restore versions.
Test interruption with zero of N rows, partial rows, empty input, unsupported projections, and changed checkpoint, schema, identity, or application ranges.
Exercise races across every guarded table, owner validity boundaries, namespace collisions, receipt conflicts, and metadata identity readback.
Inject statement failures and response loss after every commit point, then verify receipt classification and complete rollback.
Exercise crashes before source retirement, after source retirement, and during routing changes against the frozen journal.
The bounded local evidence supports the proposed SQL barrier.
The full D1 and lifecycle gates decide whether implementation can enable the route.

## Implementation status

`scripts/d1-restored-addition.ts` implements both routes as the `restoredAddition` lifecycle owner.
Its `run` and `resume` methods take the destination batch port, the journal directory, the original file, the SQLite source, and the cloud connection name.
The cutover command and the CLI do not call it, so operators still refuse restored destinations.

The owner recognizes both checkpoint layouts by exact DDL.
It accepts the four-column layout with a snapshot 5 original input, and the two-column layout with a snapshot 3 original input.
It refuses each layout with the other input version.
For the two-column layout, the owner takes the destination identity from the store, because the checkpoint records none.
The barrier view keeps the visible columns of each layout.
The packet limit is 1,000 statements, which is the D1 query limit for one Workers Paid invocation.
A caller can set a lower limit, such as 50 for Workers Free.

The current restore operator writes no checkpoint when it restores an empty input into an empty store, because it reports that store as identical.
The owner then refuses the store, because it has no recognized checkpoint.
When a checkpoint for an empty input exists, the owner applies the same checks and the same barrier as for other inputs.

The owner compares the 12 application tables with the original input, or with its snapshot 3 projection.
It captures and guards the identity and `project_memory_revisions`, but no original input records revisions, so the owner cannot compare them.
After the schema 3 upgrade, the revision values also depend on the order of the upgrade and the memory inserts.
Batch reads must reach the primary database, because a lagging replica can show an old preimage.

SQLite tests and local workerd D1 tests both pass these gates:

- A replay of each recorded restore write after the barrier changes zero rows.
- Rows deleted after the addition stay deleted when the restore writes run again. A control run without the barrier shows that the same replay restores them.
- A restore paused at each write boundary keeps the addition refused until the restore completes.
- Races on the checkpoint row, the identity, an issue, a trailing range, and the schema roll back the commit.
- A lost response resumes as committed, with one dispatch and no second addition.
- A receipt stays committed after later edits, and after a later schema change. Those changes block verification and source retirement.

The workerd D1 test also passes these gates:

- A failure at each packet statement rolls back the rename, the view, the receipt, and the added rows. The SQLite test port gets this rollback from its own transaction.
- Restore writes sent beside the commit leave the expected result.

The SQLite tests also pass these gates:

- A statement prepared before the barrier writes nothing after it.
- Races on each of the 14 guarded tables roll back the commit.
- An unchanged preimage permits one resend of the frozen packet per call, and a changed preimage is refused.
- A batch that returns without a receipt is unknown after one dispatch.
- A terminal layout without its receipt is unknown.
- An edited or malformed journal operation is refused.
- A source edit after freezing blocks source retirement, and a missing source is refused.
- A crash after the retirement commit resumes and records the step.

The release 0.1.0 route tests replay the writes that the release 0.1.0 operator sent for one snapshot 3 input.
`test/fixtures/release-0.1.0-restore.json` holds those writes, the input, the digest, and the release schema.
`node test/fixtures/record-release-0.1.0-restore.ts` records them again from the `v0.1.0` tag.
Each test applies the writes to schema 3, then applies the schema 3 upgrade.
The route shares the commit and recovery code with the four-column route.
Its tests cover the parts that change with the layout.

SQLite tests and local workerd D1 tests both pass these release 0.1.0 gates:

- The addition commits once, archives the two-column checkpoint, and records the two-column layout in the receipt.
- A replay of each recorded release 0.1.0 write after the barrier leaves the store unchanged. `CREATE TABLE IF NOT EXISTS` does nothing against the view, and the checkpoint insert fails.
- A release 0.1.0 restore paused before each write, then upgraded, keeps the addition refused until its remaining writes run.
- A snapshot 5 input for the two-column layout is refused.

The workerd D1 test also passes this release 0.1.0 gate:

- A failure at each packet statement rolls back the rename, the two-column view, the receipt, and the added rows.

The SQLite tests also pass these release 0.1.0 gates:

- The recorded digest equals the snapshot 3 canonical digest, and differs from the snapshot 5 digest of the converted input.
- The upgraded store holds the converted snapshot 3 rows, dependency revision 1 for each issue, and project memory revision 1 for each project.
- Memory inserts after a paused upgrade raise a project revision to 2, and the addition still commits after the restore completes.
- A missing, invalid, or different original input is refused.
- An edited row, checkpoint digest, or checkpoint DDL is refused, and so is a store that has not been upgraded.

These gates remain open:

- Request size, duration, and atomicity of the packet through the D1 REST batch API on a production database.
- Claim validity at commit time beyond the guards on the captured claim rows.
- Owner validity boundaries, receipt conflicts between concurrent operators, and metadata identity readback.
- A supported procedure for an addition whose source retirement waits, because a destination write followed the commit. The owner does not stop Worker writers.
- A source lock that holds from an uncertain dispatch until resume. The owner releases the lock when the outcome is unknown, so local writes in that window block source retirement. The cutover operator instead retires the source after any dispatch attempt.
- Routing changes after source retirement, with recovery for each step.
- A command that runs the owner after review and owner approval.
