# Move a shared local store to the cloud

These instructions describe version 0.3.0 with schema 6 and snapshot 5.
Version 0.2.0 uses schema 5.

This procedure adds a local store to an existing D1 store, then selects the cloud connection in your repositories.
It preserves the records already in D1.
Use the [snapshot restoration procedure](d1-migration.md) when you need to restore into a new, unbound database.

The operator requires disjoint IDs and counter namespaces across both stores.
It stops on a conflict instead of choosing one version, renaming IDs, or replacing records.
The transfer preserves issues, comments, memories, claims, counters, creation receipts, versions, timestamps, and attribution.
It also preserves receipts for deleted memories.
Claim mutation receipts retain their original payload bytes and results.
The source and destination must have different store incarnations, including when their issue namespaces are disjoint.
The operator refuses the same incarnation before it prepares any database write.
It preserves destination identity and existing destination owners, and imported claim rows retain invalidated source authority as history.
The merge batch guards the captured destination identity and project memory revisions before it inserts source rows.
Memory insertion advances destination project revisions through their existing triggers.

## Prepare the connection and repositories

Use the supported Node version, an installed `pd`, and an authenticated `cf` profile.
Run the operator from a source checkout of polylinedb.
The Worker and both stores must already use canonical schema 6.
The additive operator refuses additional application tables, including an existing `polylinedb_snapshot_claim` restoration table.
Use the separate restoration procedure or review that provenance before preparing a different operator.
The [restored D1 addition proposal](adr/0012-restored-d1-addition.md) defines a possible single addition with the original input and unchanged destination rows.
An operator library implements its four-column route and its release 0.1.0 two-column route, and the ADR lists the gates that remain open.
This cutover operator continues to refuse restored destinations, and no command runs the library.
The operator does not deploy a Worker, upgrade schemas, or change Access policies.

Register the cloud connection and complete its initial login:

```sh
	pd connection add cloud --url https://issues.example.invalid
	pd --connection cloud auth login
	pd --connection cloud actor
```

Replace the example origin with your protected Worker origin.
Credentials stay in the CLI credential store and the selected `cf` profile.
Do not include tokens or client secrets in the migration plan.

Check the local selection from each repository that uses the shared store:

```sh
	pd context
	pd export --file /srv/private-transfer/source-backup.json
```

Use your own absolute paths outside Git checkouts.
Keep backup files private.
The operator takes another final snapshot after it obtains the source write lock.

List every repository that selects this source.
The operator discovers registered linked worktrees from the supplied repositories.
Git common metadata holds one configuration for those worktrees.
The operator changes each common configuration once and checks every discovered checkout.
Repositories that select another store remain outside the transfer.

## Create the private plan

Create a JSON file outside all Git checkouts with mode `0600`.
Use an empty receipt directory with mode `0700`.
Replace every placeholder with your own value:

```json
{
  "profile": "migration",
  "accountId": "ACCOUNT_ID",
  "databaseId": "DATABASE_UUID",
  "workerId": "WORKER_NAME",
  "url": "https://issues.example.invalid",
  "connection": "cloud",
  "sourceDirectory": "/srv/personal-issues",
  "receiptsDirectory": "/srv/private-transfer/receipts",
  "repositories": ["/srv/projects/editor", "/srv/projects/compiler"]
}
```

`sourceDirectory` contains the local `polylinedb.sqlite` file.
`connection` names the registered cloud connection.
`url` must match that connection's HTTPS origin.
The operator checks that the Worker's `DB` binding selects `databaseId` in the fixed account.
Keep account IDs, database IDs, origins, repository paths, backups, and receipts outside the source checkout.

Stop source writers and configuration writers before the final run.
Pause cloud writers too, so the complete post-transfer comparison has a stable destination.
An open local agent can remain running if it stops writes during the transfer.

## Apply and verify the transfer

Run the operator only after reviewing the fixed plan:

```sh
	node scripts/d1-cutover.ts --plan /srv/private-transfer/plan.json --apply
```

The operator performs these steps:

1. Check the connection, authenticated actor, Worker binding, and repository selections.
2. Back up repository configuration files and obtain a SQLite `BEGIN IMMEDIATE` write lock.
3. Save the final source and cloud snapshots, including all ten collections.
4. Validate both snapshots and reject overlapping keys, receipts, or counter namespaces.
5. Add source records through one guarded D1 batch with bound JSON chunks.
6. Read every cloud collection and compare the complete result with the expected union.
7. Commit source retirement, then select the cloud connection in each common repository configuration.
8. Set the user default connection and check every discovered checkout's project, tool, prefix, and connection.

The D1 batch checks the captured destination inside its transaction.
A concurrent destination change or an insertion conflict aborts the entire batch.
The operator uses plain inserts and never replaces existing cloud rows.
Bound JSON chunks stay below 400,000 bytes.
The entire API batch still has Cloudflare's [30-second deadline](https://developers.cloudflare.com/d1/platform/limits/).
Do not split the batch into separate requests and assume the same atomic guarantee.

Successful output contains `result: "VERIFIED"`, collection counts, and configuration counts.
The operator stops a `cf` child after 120 seconds and a `pd` child after 60 seconds.
`POLYLINEDB_D1_CHILD_LIMIT_MS` replaces both limits.
A stopped or failed child names its limit, exit status, or signal.
The full `cf` diagnostic stays in a private `cf-failure-*.txt` receipt.
The receipt directory contains the final snapshots, digest manifest, complete cloud verification, and routing verification.
Keep these files for recovery.

Source retirement installs write-rejection triggers on ten application tables and two metadata tables.
The graph tables include edges, aggregate revisions, and immutable request receipts.
Previously opened connections also reject inserts, updates, and deletes after retirement commits.
The old store remains readable and exportable.
Blocked writes return `store_retired` and name the cloud connection to use.
Direct SQL administrators can remove those triggers, so retirement protects ordinary clients rather than administrative access.

## Check normal CLI operation

From each affected repository, confirm the selection:

```sh
	pd context
	pd actor
	pd list --project YOUR_PROJECT
	pd memory context --project YOUR_PROJECT
```

Check an existing issue with `pd show ISSUE_ID`.
Create a small task or reusable memory, then read it back.
Check a project with multiple pages and follow its `next_cursor`.
The operator's full-data comparison proves the transfer; these operations verify authenticated application use.

Cloud operations use the authenticated actor.
Omit `--actor` even when the retained repository configuration contains a local actor.
Existing creation receipts keep their original actors.
Replaying an old local request through a different cloud actor returns `request_conflict`.
Use new request UUIDs for new cloud creations.

Flags and environment selectors take precedence over repository defaults.
Remove an obsolete `POLYLINEDB_DATA_DIR` override from host startup settings.
An explicit old `--data-dir` can still read the retired store, but its writes fail with `store_retired`.
The operator clears selectors in its child processes; it does not edit your shell or other applications' environments.

Use `pd connection use cloud` for another initialized repository after confirming that its data belongs to the transferred source.
Use `pd connection default cloud` to choose the default outside configured repositories.
Changing a connection alone does not transfer data.

## Recover a stopped run

If the operator stops before attempting the cloud batch, it rolls back staged source retirement.
Check the receipts and resolve the reported conflict before preparing another run.

If the cloud batch was attempted, an absent response can mean the write committed.
The operator keeps the local source retired in that case.
Do not resume local writes or repeat creation commands with new request IDs.
Compare a fresh complete cloud read with the saved baseline and expected snapshots.

If the cloud equals the expected union, finish the remaining configuration changes and application checks.
If it equals the original baseline, investigate the failed request before applying the same fixed transfer again.
If it equals neither, inspect concurrent writes and the saved records before recovery.
The operator refuses a nonempty receipt directory instead of guessing a recovery state.

After cloud writers resume, the cloud snapshot naturally changes.
Keep the migration records and audit fields, but do not expect its digest to stay constant.
Returning to the old local store requires collecting subsequent cloud writes first.
Keeping the old file does not provide automatic rollback or synchronization.

## Verify the operator before use

```sh
	node --test test/d1-additive-merge.test.ts test/d1-cutover.test.ts
```

The merge tests exercise preservation, guarded conflicts, batch rollback, JSON chunking, and retirement of existing connections.
The cutover tests exercise repository settings and failure recovery with isolated SQLite and Git fixtures.
Those fixtures do not authenticate to Cloudflare.
An isolated live D1 transfer also verified the administrative transport with an approximately 10 MB batch.
The live run checked complete readback and rollback after a forced mid-batch failure.
