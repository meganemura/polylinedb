# Restore a local snapshot into D1

These instructions describe schema 13 and snapshot 10.
Version 0.6.0 uses schema 10 and snapshot 8. No release used schema 9 and snapshot 7, but a Worker built from main before comment edits did. Versions 0.5.0 through 0.5.2 use schema 8 and snapshot 6, versions 0.3.0 and 0.4.0 use schema 6 and snapshot 5, and version 0.2.0 uses schema 5.

To add a local store to an existing cloud store and change repository defaults, use the [shared-store cutover procedure](local-cloud-cutover.md).
The additive operator requires disjoint keys and counter namespaces.

The repository operator command restores snapshot v10 into a new D1 database.
It preserves issues and their close records, comments with their edit versions, handles, `via`, and replies, stars, asks and checks, memories, prerequisites, land order, external resources, claims, counters, request receipts, versions, and audit fields.
Ordinary `pd` commands can select SQLite or the authenticated cloud API. Snapshot maintenance remains an operator task.

## Prepare the transfer

Keep the destination unbound to Workers during the transfer. Other writers must remain stopped until verification and cutover finish. The importer does not lock out arbitrary SQL clients.

Export the source with `pd export --file SNAPSHOT`. Keep the snapshot outside Git in a private directory. Export uses a consistent SQLite transaction. Stop source writers before the final export if this snapshot will become the active cloud store.

Provision the destination with the SQL emitted by `node scripts/schema.ts`. The importer requires the canonical schema, including its stored SQL definitions. Equivalent custom DDL is refused. The operator command does not create databases or change Worker bindings.

Schema comparison excludes Cloudflare's `_cf_METADATA` and `_cf_KV` storage tables.
Other extra tables still fail the comparison.
Cloudflare documents `_cf_KV` as a reserved table in its [D1 import guide](https://developers.cloudflare.com/d1/best-practices/import-export-data/).

Create a target file with mode 0600 outside Git checkouts. Environment-specific identifiers, snapshots, and receipts must stay outside the repository. Create the target file with these fields:

```json
{
  "profile": "migration",
  "accountId": "ACCOUNT_ID",
  "databaseId": "DATABASE_UUID",
  "snapshotSha256": "CANONICAL_SNAPSHOT_SHA256",
  "schemaVersion": 12
}
```

Use the SHA-256 reported by `pd export`. Authenticate the named profile through `cf auth` separately. Credentials do not belong in the target file. Review the account, database, snapshot digest, and destination isolation before approving a restore.

```sh
node scripts/d1-snapshot.ts inspect --snapshot SNAPSHOT --target TARGET
node scripts/d1-snapshot.ts restore --snapshot SNAPSHOT --target TARGET
node scripts/d1-snapshot.ts verify --snapshot SNAPSHOT --target TARGET
node scripts/d1-snapshot.ts verify --snapshot SNAPSHOT --target TARGET --output ABSOLUTE_PRIVATE_PATH
```

The field order in the command is fixed. `inspect` reads the destination. `restore` writes the snapshot claim and missing rows.
`verify` reads all eighteen collections and compares their canonical representation with the input.
Dependency edges use numeric dependent/blocker tuple pagination, and land-order edges use numeric later/earlier tuple pagination.
Resource entries page by issue, then by entry number.
Claim aggregates, claim receipts, land-order revisions, and resource revisions use bounded pages of 100 small records.
Issues, comments, and memories retain one-record pages to bound large text responses.
Its optional `--output` writes that verified remote snapshot to a new file with mode 0600.
The output path must be absolute, and existing files are refused. Keep the output outside Git checkouts.
Each command prints a receipt with target identity, counts, and digest. The receipt excludes snapshot content.
Each `cf d1 query` child has a 60-second limit. `POLYLINEDB_D1_CHILD_LIMIT_MS` replaces it.
A failed query reports the limit, exit status, or signal, and the end of the `cf` stderr.
The excerpt replaces each run of 20 or more identifier characters with `[redacted]`, so account IDs, database IDs, and tokens stay out.

<a id="upgrade-an-existing-schema-2-3-or-4-deployment"></a>
<a id="upgrade-an-existing-schema-2-3-4-or-5-deployment"></a>
<a id="upgrade-an-existing-schema-2-3-4-5-or-6-deployment"></a>
<a id="upgrade-an-existing-schema-2-3-4-5-6-or-7-deployment"></a>
<a id="upgrade-an-existing-schema-2-3-4-5-6-7-or-8-deployment"></a>
<a id="upgrade-an-existing-schema-2-3-4-5-6-7-8-or-9-deployment"></a>
<a id="upgrade-an-existing-schema-2-3-4-5-6-7-8-9-or-10-deployment"></a>
<a id="upgrade-an-existing-schema-2-3-4-5-6-7-8-9-10-or-11-deployment"></a>

## Upgrade an existing schema 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 or 12 deployment

The new Worker needs schema 13. The CLI's `upgrade` command applies only to local SQLite.
A schema 13 Worker on a schema 12 database fails every `changes` and `wait` read and the activity page of the web view, because they read the `report_kind` and `report_text` columns of `change_events`.
A schema 12 Worker keeps working against a schema 13 database. It records no `claim_reported` event for a report.
A schema 12 Worker on a schema 11 database fails every `show`, every issue page and lane of the web view, every `close`, `claim_acquire`, `claim_handoff`, ready worklist and owner-waits read, and every `item_add` and `item_resolve`, because they read the `issue_items` table.
A schema 11 Worker keeps working against a schema 12 database. It does not see asks or checks, so it offers an issue with an open ask on the ready worklist and closes or hands off an issue whose items are open.
A schema 11 Worker on a schema 10 database fails every `show`, every issue page of the web view, and every `comment`, `star`, `unstar`, and `posts`, because they name the comment `handle`, `via`, and `reply_to` columns or the `stars` table.
A schema 10 Worker keeps working against a schema 11 database. Its comments have no handle, and it cannot star or list posts.
A schema 10 Worker on a schema 9 database fails every `show`, every issue page of the web view, and every `comment_edit`, because they name the comment `version`, `updated_at`, and `updated_by` columns.
A schema 9 Worker keeps working against a schema 10 database. It cannot edit a comment, and its new comments start at version 1.
A schema 9 Worker on a schema 8 database reads issues, but every `update`, `close`, and `reopen` fails, because the issue write reads `issue_resources`. Every land-order and resource operation, every read that asks for land order, and every change feed read fail too, because the new tables and the `relation` column are missing.
A schema 7 or later Worker fails every issue, comment, claim, and prerequisite write against a schema 6 database, because the `change_writer` table is missing.
A schema 8 Worker on a schema 7 database reads issues, but every status change and every creation with status `closed` fails, because those writes name the `closed_at` and `closed_by` columns.
Upgrade the database before deploying the Worker.
A schema 6 or 7 Worker keeps working against an upgraded database. A schema 6 Worker records no change events, and neither earlier Worker records closures, so its closes leave them null.
Keep cloud writers stopped during the operator upgrade and preserve a verified backup before changing the database.
Record the account, database UUID, and Worker binding.
Compare the deployed DDL with its `SCHEMA_V2_SQL`, `SCHEMA_V3_SQL`, `SCHEMA_V4_SQL`, or frozen `SCHEMA_V5_SQL`, `SCHEMA_V6_SQL`, `SCHEMA_V7_SQL`, `SCHEMA_V8_SQL`, `SCHEMA_V9_SQL`, `SCHEMA_V10_SQL`, `SCHEMA_V11_SQL`, or `SCHEMA_V12_SQL` definition before a write.
Preserve and verify all content collections before applying the upgrade.

Prefer restoring a converted snapshot into a new isolated database when a current v2 snapshot is available.
Run `pd snapshot convert --from 2 --file OLD --output NEW` for a v2 snapshot.
For a v3, v4, v5, v6, v7, v8, or v9 snapshot, use `--from 3`, `--from 4`, `--from 5`, `--from 6`, `--from 7`, `--from 8`, or `--from 9` instead.
Then use the new v10 digest and the normal restore procedure.
Verify the restored data before an approved Worker binding change. Keep the old database available for recovery.

For an in-place upgrade, emit the matching migration with `node scripts/schema.ts --upgrade-from 2`, `--upgrade-from 3`, `--upgrade-from 4`, `--upgrade-from 5`, `--upgrade-from 6`, `--upgrade-from 7`, `--upgrade-from 8`, `--upgrade-from 9`, `--upgrade-from 10`, `--upgrade-from 11`, or `--upgrade-from 12`.
Apply every statement in one approved D1 batch or transaction; do not send these statements through the public Worker API.
The `schemaUpgradeStatements` export provides complete statements, including trigger bodies, for a D1 batch adapter.
Do not split migration SQL at semicolons because trigger bodies contain semicolons.
The batch checks the previous version and applies its required memory migrations.
Upgrades from versions 2 through 4 create dependency tables and seed each issue at prerequisite revision 1.
Upgrades from versions 2 through 5 add empty claim collections.
Upgrades from versions 2 through 6 add the empty change feed tables and their triggers.
Upgrades from versions 2 through 7 add the `closed_at` and `closed_by` issue columns with null values.
The upgrade does not infer close times for issues that are already closed.
Upgrades from versions 2 through 8 add the nullable `change_events.relation` column, the empty land-order and resource tables, and their triggers.
They replace the `dependencies_acyclic` trigger with one that walks prerequisites and land order together.
Upgrades from versions 2 through 9 add the comment columns `version` (1 for each existing comment), `updated_at`, and `updated_by` (both null).
They then rebuild `change_events` so that its kind check accepts `comment_edited`: they drop the triggers that name `change_events`, create the new table, copy every event with its `seq`, drop the old table, rename the new one, and create the triggers again with the same text.
They add the trigger that records `comment_edited`.
Upgrades from versions 2 through 10 add the nullable comment columns `handle`, `via`, and `reply_to`, the `comments_reply_on_issue` trigger that keeps a reply on the issue of its target, the `comments_posts` index, and the empty `stars` table.
They rebuild `change_events` again, in the same steps, so that its kind check accepts `starred` and `unstarred`. They drop and recreate the thirteen triggers that name `change_events` and add the two star triggers.
Upgrades from versions 2 through 11 add the empty `issue_items` table for asks and checks.
They rebuild `change_events` a third time, in the same steps, so that its kind check accepts `asked` and `answered`. They drop and recreate the fifteen triggers that name `change_events` with their schema 11 text and add the two item triggers.
Every supported upgrade rebuilds `change_events` a fourth time, in the same steps, so that its kind check accepts `claim_reported` and the table gains the nullable `report_kind` and `report_text` columns, which only a `claim_reported` event fills. It drops and recreates the seventeen triggers that name `change_events` with their schema 12 text, adds the `claim_requests_change_report` trigger, and sets schema version 13.
D1 runs the whole upgrade in one batch, so a failure leaves the earlier database unchanged.
Check the resulting DDL against the canonical schema emitted by `node scripts/schema.ts`.
Read back all original records, versions, attribution, counters, and creation requests and compare them with the backup.
Verify that schema 2 upgrades create empty memory collections.
Verify that schema 3 upgrades preserve their memories and seed one revision row per existing memory project.
Check that `memory_store_identity` has exactly one valid incarnation.
Verify that schema 4 and 5 upgrades preserve memory identity and project revision rows.
For schema 5 and 6, verify that graph edges, revisions, and receipt payload bytes remain unchanged.
Verify that both claim collections remain empty after an upgrade from schema 2 through 5, and that schema 6 claim rows and receipts remain unchanged.
Verify that `change_events` and `change_writer` are empty after an upgrade from schema 2 through 6, and that schema 7 change events remain unchanged.
Verify that every issue has null `closed_at` and `closed_by` after an upgrade from schema 2 through 7, and that schema 8 closures remain unchanged.
Verify that `land_order`, `land_order_revisions`, `land_order_requests`, `issue_resources`, `resource_revisions`, and `resource_requests` are empty after an upgrade from schema 2 through 8, and that every change event from before schema 9 has a null `relation`.
Verify that every comment has version 1 with null `updated_at` and `updated_by` after an upgrade from schema 2 through 9, and that schema 10 comment versions and editors remain unchanged.
Verify that every comment has null `handle`, `via`, and `reply_to`, that `stars` is empty, and that every change event, with its `seq`, `relation`, and the other fields, is the same as before the upgrade.
Verify that `issue_items` is empty after an upgrade from schema 2 through 11, and that schema 12 items remain unchanged.
Verify that every change event, with its `seq`, `relation`, and the other fields, is the same as before the upgrade, with null `report_kind` and `report_text`.
After the deploy, in a test project, write one comment with a handle, star it twice, and unstar it, then read `changes` with the `commented`, `starred`, and `unstarred` kinds. The comment, the first star, and the unstar must each add one event with the next `seq`, and the repeated star must add none.
Then add an ask to a test issue, answer it from its `/ui` issue page, and read `changes` with the `asked`, `answered`, and `became_ready` kinds. The ask and the answer must each add one event with the next `seq`, and the answer must come before `became_ready` when the issue is open and unblocked.
Then claim a test issue, report `working`, `blocked`, and `error` with `claim_report`, and `wait` with the `claim_reported` kind from the position before the first report. The `blocked` and `error` reports must each add one event that carries their kind and line in `report`, and the `working` report must add none.
Deploy the new Worker only after those checks pass.
If the database operation fails or its outcome is unknown, inspect the actual schema before recovery. Do not blindly repeat table creation.

### Rollback cost of the schema 8 upgrade

The schema 7 to 8 upgrade only adds two nullable columns, so the database itself needs no rollback to run an earlier Worker.
Rolling back the Worker has these costs:

- A schema 8 Worker on a schema 7 database fails every status change, including close and reopen, and every creation with status `closed`. Deploy it only after the database upgrade.
- After a schema 8 Worker closes issues, a rollback to a schema 7 or earlier Worker makes reopen and every other status change away from `closed` fail on those issues. The earlier Worker does not clear the closure, so the column check rejects the write. Issues that the earlier Worker closes itself keep null and reopen normally.
  To roll back anyway, export a backup and then run `UPDATE issues SET closed_at = NULL, closed_by = NULL WHERE closed_at IS NOT NULL` in one approved D1 batch. This discards the recorded close records, and a later schema 8 Worker cannot recover them.
- Restoring a schema 7 backup after schema 8 writes loses every write made since the backup. Follow the raw database rollback below.

See [the closure record decision](adr/0018-issue-closure-record.md#rollout).

### Rollback cost of the schema 9 upgrade

The schema 8 to 9 upgrade adds tables, one nullable column, and triggers, so the database itself needs no rollback to run a schema 8 Worker.
Rolling back the Worker has these costs:

- A schema 8 Worker reads change events without `relation`, so a land-order event appears as a prerequisite `dependency_added` or `dependency_removed` event. Read `land_order_list` again with a schema 9 Worker for the edges.
- A schema 8 Worker cannot read or write land order. The edges stay in the database, and the shared cycle trigger still refuses a prerequisite that would close a cycle through them.
- A schema 8 Worker does not check external resources, so it closes an issue that still has live entries. After the Worker returns to schema 9, `resource_live` lists those issues.
- Restoring a schema 8 backup after schema 9 writes loses every write made since the backup. Follow the raw database rollback below.

See [the land-order decision](adr/0020-land-order.md#rollout) and [the external resources decision](adr/0021-external-resources.md#rollout).

### Rollback cost of the schema 10 upgrade

The schema 9 to 10 upgrade adds three comment columns with defaults, rebuilds `change_events`, and adds one trigger, so the database itself needs no rollback to run a schema 9 Worker.
Rolling back the Worker has these costs:

- A schema 9 Worker cannot edit a comment. It shows the current body of an edited comment without its version or edit mark.
- A schema 9 Worker refuses a `comment_edited` event that it reads, because that kind is not in its list. Every `changes` and `wait` page that holds such an event then fails. The events leave the feed after retention removes them, or after a restore rotates the incarnation.
- The comment edit trigger still records `comment_edited` for an edit, but a schema 9 Worker makes no edit, so it adds no such event.
- Restoring a schema 9 backup after schema 10 writes loses every write made since the backup, and it brings back the old body of every comment edited since the backup. Follow the raw database rollback below.

See [the comment edit decision](adr/0022-comment-edits.md#rollout).

### Rollback cost of the schema 11 upgrade

The schema 10 to 11 upgrade adds three nullable comment columns, one index, one table, rebuilds `change_events`, and adds triggers, so the database itself needs no rollback to run a schema 10 Worker.
Rolling back the Worker has these costs:

- A schema 10 Worker cannot star, unstar, or list posts, and its comments have no handle, `via`, or reply. It shows existing posts as plain comments, without their persona or star count.
- A schema 10 Worker refuses a `starred` or `unstarred` event that it reads, because those kinds are not in its list. Every `changes` and `wait` page that holds such an event then fails. The events leave the feed after retention removes them, or after a restore rotates the incarnation.
- The stars stay in the database. The star triggers still record events for a star change, but a schema 10 Worker makes none.
- Restoring a schema 10 backup after schema 11 writes loses every write made since the backup, including every handle, `via`, reply, and star. Follow the raw database rollback below.

See [the posts and stars decision](adr/0023-posts-and-stars.md#rollout).

### Rollback cost of the schema 12 upgrade

The schema 11 to 12 upgrade adds one table, rebuilds `change_events`, and adds two triggers, so the database itself needs no rollback to run a schema 11 Worker.
Rolling back the Worker has these costs:

- A schema 11 Worker cannot add, answer, or list asks and checks. It offers an issue with an open ask on the ready worklist, leaves it out of owner waits, and closes or hands off an issue with open items.
- A schema 11 Worker refuses an `asked` or `answered` event that it reads, because those kinds are not in its list. Every `changes` and `wait` page that holds such an event then fails. The events leave the feed after retention removes them, or after a restore rotates the incarnation.
- The items stay in the database, and the item triggers still record events, but a schema 11 Worker makes no item write.
- Restoring a schema 11 backup after schema 12 writes loses every write made since the backup, including every ask, answer, and check. Follow the raw database rollback below.

See [the asks and checks decision](adr/0024-asks-and-checks.md#rollout).

### Rollback cost of the schema 13 upgrade

The schema 12 to 13 upgrade rebuilds `change_events` with two nullable columns and adds one trigger, so the database itself needs no rollback to run a schema 12 Worker.
Rolling back the Worker has these costs:

- A schema 12 Worker refuses a `claim_reported` event that it reads, because that kind is not in its list. Every `changes` and `wait` page that holds such an event then fails. The events leave the feed after retention removes them, or after a restore rotates the incarnation.
- The report trigger still records `claim_reported` for each `blocked` or `error` report that a schema 12 Worker writes, so those pages keep failing while holders report. Roll back only when no holder reports, or restore.
- Restoring a schema 12 backup after schema 13 writes loses every write made since the backup. Follow the raw database rollback below.

The application does not perform this remote upgrade automatically. This procedure requires separate operator approval and live verification.
For a raw database rollback, stop readers and writers, restore, rotate the incarnation, then resume traffic.
See [the restore contract](adr/0005-memory-freshness.md#raw-database-restore) for the exact SQL and verification.
This rotation also invalidates issue claim proofs.
An arbitrary raw copy that retains the original incarnation cannot be detected by the application.

## Recovery

A destination can be empty, identical, or a matching partial restore. A partial restore requires the durable `polylinedb_snapshot_claim` row with the same digest. Existing rows must exactly match expected rows, including derived parent IDs and sort keys. Different rows, unrelated rows, another digest, and partial data without a claim are refused.

Repeat the same restore command after an interruption. Inserts use bound parameters and check the claim.
Issue insertion creates prerequisite baselines. Restore replaces those revision-1 baselines with the exact snapshot revisions under the same claim.
Differing graph edges, receipts, or later revision values fail inspection.
A request can commit before its response disappears; the next run reads the actual destination before it continues.
The claim remains as provenance after success.
The restore claim records its original incarnation and one new incarnation before it rotates the destination.
Resume verifies that record and retains the same rotation target.
It does not rotate again after a successful restore or overwrite claims acquired after restoration.
Imported claim rows retain source incarnations as history, so source proofs cannot authorize destination writes.
Historical request UUIDs still replay their original receipts.
Snapshot validation rejects dangling claim receipts and receipt counters above their aggregate, across every incarnation.

A retired historical local store rejects `pd upgrade` and retains its write guards.
Use `pd export --historical --file SNAPSHOT` for read-only recovery from canonical schema 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, or 12.
That export converts the content to snapshot 10 with no asks or checks, with empty land order and resources before schema 9, with null close records before schema 8, with each comment at version 1 and no editor before schema 10, and with no handle, `via`, reply, or star before schema 11. Schema 6, 7, and 8 claim records remain intact; earlier schemas receive empty claim collections.
Schema 5 through 8 graph records remain intact; earlier schemas receive empty prerequisites and baseline revisions.
It preserves creation payload strings and source attribution. Transfer it into a separately initialized destination.

Create-request records retain their original actor. Replaying a local request through a different cloud actor returns `request_conflict`. New cloud operations use new request IDs.

Keep the target file and source snapshot unchanged across retries. A changed source snapshot needs a new destination. After remote verification, keep the source backup and receipt. Obtain approval before binding or deploying the production Worker.

## Transport and limits

The command uses `cf d1 query DATABASE_UUID --profile PROFILE --batch @FILE`. Each request contains one bound statement. Temporary files have mode 0600 inside private temporary directories and are removed after success or failure. The child process receives a fixed `CLOUDFLARE_ACCOUNT_ID`. Ambient API-token variables are removed so the named profile owns authentication. Child stderr is not copied into operator output.

An isolated live D1 transfer passed with cf 1.0.0-beta.12 on October 4, 2026.
It used an installed CLI package to export issues and memories, restore them into D1, and import the verified snapshot into fresh SQLite.
The canonical contents matched, including versions, attribution, deleted-memory receipts, and counters.
The run also verified recovery after a committed write lost its response, repeated restore, concurrent memory conflicts, and D1 REST batch rollback.
The importer checks supported output envelopes and every statement success value.
These checks used the operator's D1 REST access. Deployed Worker bindings and OAuth require separate acceptance checks.
Workerd tests use the real D1 binding directly and do not prove production authentication.

D1 permits 100 bound parameters and 100,000 SQL bytes per statement.
The whole API batch has a 30-second deadline.
Bound values keep large UTF-8 bodies outside SQL text.
The operator limits encoded rows to 1,900,000 bytes.
It reads large issue, comment, and memory records in one-record pages and small claim records in pages of at most 100.
See [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Verification

```sh
node --test test/d1-snapshot.test.ts
node test/d1-snapshot.integration.ts
node --test test/d1-restored-addition.test.ts
node test/d1-restored-addition.integration.ts
```

The restored addition tests cover the gates that the [restored D1 addition ADR](adr/0012-restored-d1-addition.md#implementation-status) lists as passed.

The integration tests require the same external Miniflare installation used by `test/d1.integration.ts`. An optional module path can be passed as the first argument.
The integration tests send their D1 calls through a relay worker over keep-alive connections.
Miniflare's binding proxy closes the connection after every call, and the test makes thousands of calls, which would fill the macOS ephemeral port range with TIME_WAIT sockets.

The tests cover committed-response-loss recovery, duplicate and concurrent restores, conflicting claims and rows, corrupt sort keys, and a 64 KiB issue body.
They preserve issue and memory versions, audit fields, comments, counters, and creation requests.
They compare the D1 snapshot with a fresh SQLite import/export and check that deleted memory requests cannot recreate records.
They also verify subsequent issue and memory numbers. Transport tests inspect target arguments, bound values, private files, cleanup, and sanitized failures.

For a release acceptance run, use `verify --output` to save the D1-read snapshot. Import that file into a fresh SQLite store through the installed tarball and compare its export. Keep that result separate from source-tree test results. Production credentials, a live remote transfer, and Worker cutover require their own verification and approval.
