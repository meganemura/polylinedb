# Record who closed an issue and when

Status: accepted for schema 8 and snapshot 6. The production D1 upgrade and Worker deploy wait for owner approval.

## Problem

An issue held `created_at` and `created_by`, and `updated_at` and `updated_by`.
It held no close time.
A field edit after the close moves `updated_at`, so the last update is not the close time.
A reader that lists recently closed issues had to use the last update and say that it is not the close time.

## Decision

Schema 8 adds two nullable issue columns, `closed_at` and `closed_by`.
They describe the current closed state of the issue:

| Write | `closed_at` and `closed_by` |
| --- | --- |
| A status change from another status to `closed`, forced or not | Set to the write time and the actor. `closed_at` equals the new `updated_at`. |
| A creation with status `closed` | Set to the creation time and the creator. |
| A status change from `closed` to `closed` | Kept. The issue does not enter the closed state again. |
| A status change away from `closed`, including reopen | Cleared to null. |
| Any other field change | Kept. |

A cleared closure keeps no history of earlier closes.
The comments, the field versions, and the change feed remain the history of an issue.
A history of closes would need its own collection, and no reader needs it now.

Null on a closed issue means that the store holds no close record.
Issues closed before schema 8 keep null.
The upgrade does not copy `updated_at` into `closed_at`, because that time can come from a later edit.

The column check allows two states only:
both columns are null, or both are nonempty text and the status is `closed`.
SQLite and D1 enforce it on every write, and snapshot validation applies the same rule.

## Schema and snapshot

A new store and an upgraded store add the two columns with the same `ALTER TABLE` statements, after the change feed DDL of [schema 7](0016-change-feed.md).
SQLite rewrites the stored table definition after `ALTER TABLE`, and the restore tools compare stored definitions byte for byte.
So both paths must give the same text.
Schema 7 is frozen as a literal, so an upgrade from schema 7 compares the store against its exact DDL.

`node scripts/schema.ts --upgrade-from 7` emits the D1 migration for a store that has the change feed.
The local `pd upgrade` applies the same statements to SQLite.
Upgrades from schemas 2 through 6 add the change feed and the closure columns in one batch.

Snapshot 6 adds `closed_at` and `closed_by` to every issue.
`pd snapshot convert --from 5` converts snapshot 5 with null closures.
A D1 store restored from snapshot 5 and upgraded to schema 8 holds the rows that this conversion gives.
The restored-addition tool accepts the snapshot 5 input for such a store.

## Change feed

The closure is written in the same `UPDATE` as the status.
The feed trigger compares field versions, and the closure columns have none.
So a close records one `status_changed` event with `fields: ["status"]`, as it did in schema 7.
A closure adds no event kind and no field name.
A feed reader reads the issue again for its closure, as for every other change.

## Transports

The local CLI and MCP return both fields on each issue.

CLI 0.3.1 and earlier decode `/v1/operations` responses with exact key sets.
They reject any issue key that they do not know.
CLI 0.4.0 ignores unknown response fields, but earlier installed CLIs still call the same Worker.
So the Worker removes `closed_at` and `closed_by` from the issue objects in `/v1/operations` success and error bodies.
The cloud CLI then gets the released issue shape, and its issues carry no closure fields.
An absent field means that the transport did not report the closure.

A later change can let new clients ask for the closure on `/v1/operations`.
The request needs an opt-in that earlier clients never send, and the client must accept both shapes until every Worker sends the fields.
That opt-in is now the request header `polylinedb-issue-fields: closure`; see `docs/operations.md`.
A header keeps every operation body unchanged, so no operation schema gains a field.

## Rollout

Apply the schema 8 migration to D1 before the Worker deploy.
A schema 7 Worker reads schema 8 rows, because it ignores the extra columns.
It writes no closure, so its closes leave null.
A schema 8 Worker on a schema 7 database reads issues, but every status change and every creation with status `closed` fails, because those writes name the new columns.

After a schema 8 Worker closes issues, a rollback to a schema 7 Worker makes reopen fail on those issues.
The schema 7 Worker does not clear the closure, so the column check rejects the reopen.
Clearing the recorded closures with one `UPDATE` before the rollback removes that failure and discards the close records.
The [D1 upgrade procedure](../d1-migration.md#rollback-cost-of-the-schema-8-upgrade) lists these costs for the operator.
