# Record who closed an issue and when

Status: accepted for schema 7 and snapshot 6.

## Problem

An issue held `created_at` and `created_by`, and `updated_at` and `updated_by`.
It held no close time.
A field edit after the close moves `updated_at`, so the last update is not the close time.
A reader that lists recently closed issues had to use the last update and say that it is not the close time.

## Decision

Schema 7 adds two nullable issue columns, `closed_at` and `closed_by`.
They describe the current closed state of the issue:

| Write | `closed_at` and `closed_by` |
| --- | --- |
| A status change from another status to `closed`, forced or not | Set to the write time and the actor. `closed_at` equals the new `updated_at`. |
| A creation with status `closed` | Set to the creation time and the creator. |
| A status change from `closed` to `closed` | Kept. The issue does not enter the closed state again. |
| A status change away from `closed`, including reopen | Cleared to null. |
| Any other field change | Kept. |

A cleared closure keeps no history of earlier closes.
The comments and the field versions remain the history of an issue.
A history of closes would need its own collection, and no reader needs it now.

Null on a closed issue means that the store holds no close record.
Issues closed before schema 7 keep null.
The upgrade does not copy `updated_at` into `closed_at`, because that time can come from a later edit.

The column check allows two states only:
both columns are null, or both are nonempty text and the status is `closed`.
SQLite and D1 enforce it on every write, and snapshot validation applies the same rule.

## Schema and snapshot

A new store and an upgraded store add the two columns with the same `ALTER TABLE` statements.
SQLite rewrites the stored table definition after `ALTER TABLE`, and the restore tools compare stored definitions byte for byte.
So both paths must give the same text.

`node scripts/schema.ts --upgrade-from 6` emits the D1 migration.
The local `pd upgrade` applies the same statements to SQLite.

Snapshot 6 adds `closed_at` and `closed_by` to every issue.
`pd snapshot convert --from 5` converts snapshot 5 with null closures.
A D1 store restored from snapshot 5 and upgraded to schema 7 holds the rows that this conversion gives.
The restored-addition tool accepts the snapshot 5 input for such a store.

## Transports

The local CLI and MCP return both fields on each issue.

The released CLI 0.3.1 decodes `/v1/operations` responses with exact key sets.
It rejects any issue key that it does not know.
So the Worker removes `closed_at` and `closed_by` from the issue objects in `/v1/operations` success and error bodies.
The cloud CLI then gets the 0.3.1 issue shape, and its issues carry no closure fields.
An absent field means that the transport did not report the closure.

A later change can let new clients ask for the closure on `/v1/operations`.
The request needs an opt-in that 0.3.1 never sends, and the client must accept both shapes until every Worker sends the fields.

## Rollout

Apply the schema 7 migration to D1 before the Worker deploy.
A schema 6 Worker reads schema 7 rows, because it ignores the extra columns.
It writes no closure, so its closes leave null.
A schema 7 Worker on a schema 6 database reads issues, but every status change and every creation with status `closed` fails, because those writes name the new columns.

After a schema 7 Worker closes issues, a rollback to a schema 6 Worker makes reopen fail on those issues.
The schema 6 Worker does not clear the closure, so the column check rejects the reopen.
