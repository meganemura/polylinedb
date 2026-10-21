# Restore a local snapshot into D1

These instructions describe schema 10 and snapshot 8.
Version 0.6.0 uses schema 10 and snapshot 8. No release used schema 9 and snapshot 7, but a Worker built from main before comment edits did. Versions 0.5.0 through 0.5.2 use schema 8 and snapshot 6, versions 0.3.0 and 0.4.0 use schema 6 and snapshot 5, and version 0.2.0 uses schema 5.

To add a local store to an existing cloud store and change repository defaults, use the [shared-store cutover procedure](local-cloud-cutover.md).
The additive operator requires disjoint keys and counter namespaces.

The repository operator command restores snapshot v8 into a new D1 database.
It preserves issues and their close records, comments with their edit versions, memories, prerequisites, land order, external resources, claims, counters, request receipts, versions, and audit fields.
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
  "schemaVersion": 10
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

## Upgrade an existing schema 2, 3, 4, 5, 6, 7, 8 or 9 deployment

The new Worker needs schema 10. The CLI's `upgrade` command applies only to local SQLite.
A schema 10 Worker on a schema 9 database fails every `show`, every issue page of the web view, and every `comment_edit`, because they name the comment `version`, `updated_at`, and `updated_by` columns.
A schema 9 Worker keeps working against a schema 10 database. It cannot edit a comment, and its new comments start at version 1.
A schema 9 Worker on a schema 8 database reads issues, but every `update`, `close`, and `reopen` fails, because the issue write reads `issue_resources`. Every land-order and resource operation, every read that asks for land order, and every change feed read fail too, because the new tables and the `relation` column are missing.
A schema 7 or later Worker fails every issue, comment, claim, and prerequisite write against a schema 6 database, because the `change_writer` table is missing.
A schema 8 Worker on a schema 7 database reads issues, but every status change and every creation with status `closed` fails, because those writes name the `closed_at` and `closed_by` columns.
Upgrade the database before deploying the Worker.
A schema 6 or 7 Worker keeps working against an upgraded database. A schema 6 Worker records no change events, and neither earlier Worker records closures, so its closes leave them null.
Keep cloud writers stopped during the operator upgrade and preserve a verified backup before changing the database.
Record the account, database UUID, and Worker binding.
Compare the deployed DDL with its `SCHEMA_V2_SQL`, `SCHEMA_V3_SQL`, `SCHEMA_V4_SQL`, or frozen `SCHEMA_V5_SQL`, `SCHEMA_V6_SQL`, `SCHEMA_V7_SQL`, `SCHEMA_V8_SQL`, or `SCHEMA_V9_SQL` definition before a write.
Preserve and verify all content collections before applying the upgrade.

Prefer restoring a converted snapshot into a new isolated database when a current v2 snapshot is available.
Run `pd snapshot convert --from 2 --file OLD --output NEW` for a v2 snapshot.
For a v3, v4, v5, v6, or v7 snapshot, use `--from 3`, `--from 4`, `--from 5`, `--from 6`, or `--from 7` instead.
Then use the new v8 digest and the normal restore procedure.
Verify the restored data before an approved Worker binding change. Keep the old database available for recovery.

For an in-place upgrade, emit the matching migration with `node scripts/schema.ts --upgrade-from 2`, `--upgrade-from 3`, `--upgrade-from 4`, `--upgrade-from 5`, `--upgrade-from 6`, `--upgrade-from 7`, `--upgrade-from 8`, or `--upgrade-from 9`.
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
Every supported upgrade adds the comment columns `version` (1 for each existing comment), `updated_at`, and `updated_by` (both null).
It then rebuilds `change_events` so that its kind check accepts `comment_edited`: it drops the triggers that name `change_events`, creates the new table, copies every event with its `seq`, drops the old table, renames the new one, and creates the triggers again with the same text.
It adds the trigger that records `comment_edited` and sets schema version 10.
D1 runs the whole upgrade in one batch, so a failure leaves the schema 9 database unchanged.
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
Verify that every comment has version 1 with null `updated_at` and `updated_by`, and that every change event, with its `seq`, `relation`, and the other fields, is the same as before the upgrade.
After the deploy, write one comment and edit it in a test project, then read `changes` with the `commented` and `comment_edited` kinds. Each write must add one event with the next `seq`.
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
Use `pd export --historical --file SNAPSHOT` for read-only recovery from canonical schema 2, 3, 4, 5, 6, 7, 8, or 9.
That export converts the content to snapshot 8 with empty land order and resources before schema 9, with null close records before schema 8, and with each comment at version 1 and no editor. Schema 6, 7, and 8 claim records remain intact; earlier schemas receive empty claim collections.
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
