# Add once to an unchanged restored D1 store

Status: Proposed. The four-column and two-column routes have a tested operator library and a command entry point. The command needs code review and owner approval before it runs against a real resource.

## Problem

The additive operator expects canonical schema 6 and rejects `polylinedb_snapshot_claim` before it plans a transfer.
The restore checkpoint identifies the original input, but its presence does not establish completed restoration.
A SQLite interruption before the first issue insertion leaves a valid checkpoint and the chosen destination identity.
Later application edits retain the checkpoint SHA, while verification against the original snapshot rejects the changed rows.
These observations establish the current ambiguity, rather than support for a new D1 route.

## Decision and caller contract

Propose one addition of disjoint local records immediately after restoration, while destination rows exactly match the original input.
One lifecycle owner exposes `run`, `resume`, and `releaseSource` with validated domain arguments and outcomes.
The caller supplies the original restore file, the source, the destination, the connection settings, the routed repositories, and one private journal directory.
Preparation, commit, recovery, routing, and finish remain private methods.
The public API does not expose raw queries or checkpoint layouts.
This ADR defines implementation conditions. The command entry point only validates a plan and adapts `cf` output for the owner.
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

Before dispatch, durably save the original file, version, canonical digest, source and destination rows, metadata, planned packet, routing plan, and operation identity.
The frozen digest in the receipt covers the routing plan, so an edited plan in the journal is refused.
The private journal records each lifecycle boundary and retains the frozen source through uncertainty.
Recovery never refreshes captured revisions, overwrites conflicts, or allocates a new operation identity.

The owner commits source retirement in the transaction that read the frozen source rows, before the first dispatch.
A SQLite lock ends with its process, so only committed retirement triggers keep local writes out between an uncertain dispatch and resume.
This order follows ADR 0004, which also keeps the source retired after an uncertain cloud response.

A matching receipt with consistent terminal metadata confirms commit, even when later legitimate edits change the live digest.
An absent receipt with the exact unchanged preimage permits retry of the same packet.
Changed evidence causes refusal, and unavailable or contradictory evidence leaves the outcome unknown.
After confirmed commit, the owner verifies the complete result and the destination identity, and then changes routing.

A destination write after the commit changes the result without changing the committed receipt.
Then routing waits until an operator resumes with `acceptDestinationEdits`.
That explicit decision still requires the matching receipt and the frozen destination identity, and the journal records the observed digest beside the expected digest.
The owner never accepts later edits by itself.

`releaseSource` removes the retirement triggers only when destination evidence proves that the frozen packet did not commit and cannot commit.
That proof is a different receipt, or a changed preimage or schema without a matching receipt.
An unchanged preimage refuses release, because the frozen packet can still commit, and a matching receipt keeps the source retired.
Release also requires the source rows to equal the frozen rows, and it ends the journal.
A crash after the retirement record and before the first dispatch leaves a retired source and an unchanged destination. Release refuses that state, and resume sends the frozen packet.
A changed preimage that later returns to the exact baseline would let a lost packet commit after release; the guards cannot detect that sequence.

## Routing after a verified addition

Routing here means the local connection selection that makes `pd` use the cloud connection instead of the source store.
It does not change Worker routing or any Cloudflare resource.

Before dispatch, the owner freezes a routing plan from the stored settings.
The target connection must be a configured cloud connection, and the plan records its URL.
Each supplied repository must have repository defaults that select the source directory, through a version 2 `data_dir` or a named local connection.
Repositories that share Git common metadata, such as worktrees, share one routing step.
The user default becomes a step only when it names a local connection to the source directory.
A plan with no step is refused, because nothing would move off the source.
Process overrides such as `POLYLINEDB_CONNECTION` do not affect the plan or its verification.

Each step is one change under the existing workspace locks: `useRepositoryConnection` for repository defaults and `defaultConnection` for the user default.
A step writes only when the current value equals its frozen value.
When the current value already equals the target, recovery records the step without a write.
Any other value is a later decision, so routing refuses and leaves the setting unchanged.
Earlier recorded steps stay recorded.
After every step, the owner checks that each supplied checkout selects the cloud connection with its frozen tool, project, prefix, and actor.
A changed cloud connection URL also refuses routing.

Routing does not cover checkouts that the caller did not supply, other machines, or a legacy default directory without a user default.
Those clients still reach the retired source, whose triggers refuse writes and name the cloud connection.

## Tradeoffs and implementation gates

Requiring the original file and unchanged rows limits eligible destinations but gives a bounded proof without a reusable restore completion ledger.
Permanent archival preserves provenance and fences inspected old SQL, at the cost of one addition per restored destination.
A permit protocol across all domain writers expands this limited operator change into a broader runtime redesign, so this proposal rejects that alternative.
Retirement before dispatch costs a release step after every refused addition, and that release needs destination proof. A lock held only in process would cost a possible split between the committed destination and later local writes.
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
The owner takes the destination batch port, the journal directory, and the environment that locates the connection settings.
Its `run` method takes the original file, the SQLite source, the cloud connection name, and the routed repositories.
The journal records `operation.json`, `retired.json`, `dispatch-N.json`, `committed.json`, `verified.json`, `route-N.json`, and `routed.json`, in that order.

`scripts/d1-restored-addition-command.ts` runs the owner from a private plan file with `--run`, `--resume`, `--resume --accept-destination-edits`, or `--release-source`.
The plan names the `cf` profile, the account, the D1 database, the cloud connection and its URL, the original file, the source, the journal, and the repositories.
The command refuses a plan whose URL differs from the named cloud connection.
It sends each batch through `cf d1 query --batch`, as the cutover command does, and runs only when the module is the entry point.
Exit status 2 reports a refusal, and exit status 3 reports an unknown outcome.
No test spawns `cf`. The command has not run against a real resource.
The cutover command and the CLI do not call the owner.

The owner recognizes both checkpoint layouts by exact DDL.
It accepts the four-column layout with a snapshot 5 or snapshot 6 original input, and the two-column layout with a snapshot 3 original input.
Schema 7 adds issue close records, and the upgrade from schema 6 leaves them null, so a snapshot 5 input projects through the snapshot 5 conversion.
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
- A receipt stays committed after later edits, and after a later schema change. Those changes block verification and routing.

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
- A missing source is refused.

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
- A race on the two-column checkpoint row rolls back the commit, and resume refuses the changed preimage.

The workerd D1 test also passes these release 0.1.0 gates:

- A failure at each packet statement rolls back the rename, the two-column view, the receipt, and the added rows.
- Release 0.1.0 restore writes sent beside the commit leave the expected result.

The SQLite tests also pass these release 0.1.0 gates:

- The recorded digest equals the snapshot 3 canonical digest, and differs from the snapshot 5 digest of the converted input.
- The upgraded store holds the converted snapshot 3 rows, dependency revision 1 for each issue, and project memory revision 1 for each project.
- Memory inserts after a paused upgrade raise a project revision to 2, and the addition still commits after the restore completes.
- A missing, invalid, or different original input is refused.
- An edited row, checkpoint digest, or checkpoint DDL is refused, and so is a store that has not been upgraded.

The SQLite tests also pass these lifecycle and routing gates:

- The source has all retirement triggers when the packet is dispatched, and a local write after an uncertain dispatch fails.
- A crash before the retirement record resumes. A source edit before retirement is refused before any dispatch.
- A source that another addition retired is refused before freezing.
- After each commit race, `releaseSource` lifts the retirement, the source accepts writes again, and resume refuses the released journal.
- Release refuses an unchanged preimage and a committed addition.
- Two operators frozen against one destination commit one receipt. The other operator's resume refuses the different addition, and it can release its source.
- A destination edit after the commit holds routing. Release refuses, and acceptance refuses a changed destination identity. Acceptance with the frozen identity records both digests and routes.
- Routing switches a version 2 repository default, a named local connection, and its worktree with one step, and it keeps the tool, project, prefix, and actor. An unrelated user default stays unchanged.
- A crash before or after each repository and user default write resumes to the same routes.
- A setting changed after freezing refuses routing and keeps the change. A changed cloud connection URL refuses routing.
- A target that is not a cloud connection, a repository without defaults, a repository that selects another store, and an empty plan are refused before the source is retired.
- A live source claim is `invalidated` in the destination, because its incarnation differs from the destination incarnation. Destination claim states do not change.
- The command runs, resumes, and refuses release through an injected SQLite batch port. It validates the arguments, the private plan, and the `cf` result shapes.

The workerd D1 test also passes these lifecycle gates:

- After each of the six commit races, `releaseSource` reads the D1 destination and lifts the source retirement.
- A destination edit after a lost response routes after explicit acceptance.

Gate status:

- Claim validity at commit is bounded, and no further code is required. A claim state depends on the claim row, the store incarnation, and the database clock. The packet guards every claim row and the identity, and it writes no destination claim and no identity. Imported claims keep the source incarnation, so they are invalidated history. A lease that expires between freezing and commit changes no row, and the addition does not read lease states.
- Claim owner validity is bounded by the eligibility rule, and no further code is required. Restoration gives the destination a new incarnation, so every restored claim is `invalidated` at freezing, and the two-column route has no claims. A new destination owner must acquire a claim, which changes a guarded row, so the addition refuses. The refusal test with a late `claim_acquire` and the imported claim test cover both boundaries.
- Concurrent operators are closed by the singleton immutable receipt and the source retirement. One receipt commits, and the other operator gets a refusal and a supported release. Two processes on one journal are not supported. Each journal record uses exclusive creation, so a racing duplicate step fails instead of overwriting.
- Metadata identity readback is closed. Verification and acceptance both compare the destination identity with the receipt.
- A destination write after the commit has the supported acceptance procedure above. The owner does not stop Worker writers.
- The source lock window is closed by retirement before dispatch. A refused addition needs `releaseSource`, which needs destination proof.
- Routing changes and their recovery are implemented for the stored local selection. The bounds in the routing section still apply.
- The command entry point exists and needs code review before any use against a real resource.

These gates remain open, and each needs a real D1 database under an owner-approved procedure:

- Request size, duration, and atomicity of the packet through `cf d1 query --batch` on a production database.
- Whether reads through `cf d1 query` reach the primary database, so that a lagging replica cannot show an old preimage.
- Whether the Worker behind the plan URL binds the planned D1 database. The command checks the connection URL, but not the Worker binding.
