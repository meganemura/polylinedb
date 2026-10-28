# Comment edits

Status: accepted for schema 10 and snapshot 8. The production D1 upgrade and Worker deploy wait for owner approval.

## Problem

A comment could only be appended.
A comment with a wrong command, a wrong issue reference, or text that must not stay in the store had no repair.
A second comment can correct the first one, but a reader who reads only the first one still acts on it, and search still finds it.

## Decision

`comment_edit` replaces the body of one comment.
It takes `id`, `comment_id`, `body`, and `expected`, the comment version that the caller read.
The body has the same limits as `comment`. The result is `{ comment }`.

### Author only

Only the author can edit a comment: the actor of the request must be the `created_by` value of the comment.
Another actor gets `comment_author_required` (403). The details give the issue ID and the comment ID, and never the body.
An agent caller also needs its own active claim on the issue, the same gate as `comment`.
The author check comes first, so an agent that did not write the comment gets `comment_author_required`, not `claim_required`.

### Optimistic version

Each comment has a `version` that starts at 1. Each accepted edit adds 1.
The write is one conditional `UPDATE ... WHERE ... AND created_by = ? AND version = ? AND version < MAX`, so two writers that read the same version produce one accepted edit and one `comment_conflict` (409).
The conflict details give the current comment and the `expected` value, so the caller can decide again.
At the maximum safe integer, the edit fails with `comment_version_exhausted` (409).
A missing issue gives `not_found` with its usual details, and a missing comment gives `comment_not_found` (404) with the issue ID and the comment ID.
A pure transition, `decideCommentEdit`, chooses the refusal from what the same batch read after the `UPDATE` matched no row. SQLite and D1 share the statement and the transition.

`updated_at` and `updated_by` are null until the first edit and record the last edit after it.
A check constraint keeps the three columns consistent: version 1 has no editor, and a later version has both.
The editor is always the author, and the decoders of the store, the snapshot, and the cloud client refuse a comment whose editor is another actor.

An edit leaves the issue fields, the field versions, and the issue `updated_at` unchanged, as `comment` does.

### No history

The store keeps only the current body. An edit does not keep the old text anywhere in the store, and search stops finding it.
This makes an edit a redaction: the reason to edit a comment is often that its text must not stay.
Copies made before the edit still hold the old text: exported snapshots, D1 Time Travel, and other backups.
The documentation says so, and says that removing the text from those copies means removing or replacing each copy.

### Change feed

The change kind `comment_edited` records an accepted edit, with `fields: []`.
A trigger records it when the comment version changes, with the actor of the `change_writer` row, as the other feed triggers do.
A rejected edit changes no row, so it records nothing.

SQLite cannot change a check constraint in place, and the `change_events` kind check listed the nine earlier kinds.
Schema 10 therefore rebuilds the table: it creates `change_events_v10` with the new check, copies every row with its `seq`, drops the old table, and renames the new one.
`ALTER TABLE ... RENAME` fails while a trigger names a table that does not exist, so the upgrade first drops the twelve triggers that name `change_events`: the ten that write the feed, the retention trigger, and the trigger that clears the feed when the incarnation rotates.
It creates them again with their exact schema 9 text after the rename.
A fresh store runs the same statements in the same order, so its DDL is the same as that of an upgraded store, including the quoted table name that SQLite stores after a rename.
Every event keeps its `seq` and its `incarnation`, so a cursor that a reader holds stays valid.

## Options compared

**Append-only correction comment.** A new comment that says the earlier one is wrong needs no schema change.
It does not remove the wrong text from reads or from search, so it fails the redaction case, and a reader of the first comment can miss the correction.
Refused.

**Keep each earlier body.** A history table would let a reader see what changed.
It would keep the text that an edit is meant to remove, and it would need its own retention, snapshot collection, and access rules.
The change feed already records that an edit happened and who made it.
Refused.

**Owner override.** Letting the store owner, or any human actor, edit any comment would allow moderation.
It would also let one actor change words attributed to another, and `created_by` would no longer identify who wrote the text.
A comment that must go can be handled by its author, or by a restore under the owner's control.
Refused for now. It can be added later as a separate operation with its own audit.

## Transports

All transports share the operation: the local store, HTTP `/v1/operations`, MCP, and the CLI (`pd comment edit ISSUE COMMENT_ID --expected N`).
`comment_edit` is a write. Its MCP hints are `readOnlyHint: false`, `destructiveHint: true` (it replaces current text), and `idempotentHint: true` (a repeat gets `comment_conflict` and writes nothing).
Every comment in a result has `version`, `updated_at`, and `updated_by`.
A released cloud client keeps only the five comment keys that it knows, so the new fields do not break it.
The current client decodes a comment without the three fields from an older Worker, and refuses a comment with only some of them.
An older Worker answers `comment_edit` with `invalid_input`; the client reports that the Worker needs an update and does not retry.
The human `pd show` prints the version of each comment and marks an edited one. The web view marks an edited comment and has no edit control.

## Schema and snapshot

Schema 10 adds the three comment columns with `ALTER TABLE`, rebuilds `change_events`, and adds the comment edit trigger, after the schema 9 objects, on a fresh store and an upgrade alike.
`src/records/persistence/schema-v9.ts` freezes the schema 9 statements for upgrades and tests.
Snapshot 8 carries `version`, `updated_at`, and `updated_by` on every comment. A snapshot 7 converts with version 1 and null editor fields.
Export, import, historical export, the D1 snapshot operator, the additive merge, and the restored addition all carry the three fields.

## Rollout

Upgrade the D1 database before deploying the Worker: a schema 10 Worker on a schema 9 database fails every `show`.
A schema 9 Worker on a schema 10 database keeps working and cannot edit.
After edits, a rollback to a schema 9 Worker fails each change feed page that holds a `comment_edited` event, because that Worker refuses a kind that it does not know.
[The D1 migration guide](../d1-migration.md#rollback-cost-of-the-schema-10-upgrade) lists the steps and the rollback costs.

## Verification

`test/comment-edit.test.ts` and `test/comment-edit-d1.integration.ts` run the same flows on SQLite and on local workerd D1: an accepted edit and its event, each refusal with no event, a race between two writers, the version limit, the schema 9 to 10 upgrade of a populated store with its events and `seq`, and the full change feed flow on an upgraded store.
A Hegel property checks that, for any sequence of edits, the store accepts exactly the edits whose `expected` value is the current version, and keeps the last accepted body.
`test/worker.test.ts` and `test/worker.integration.ts` check the HTTP and MCP paths, the hints, and the web view. `test/cloud-compatibility.test.ts` checks the client decoders.
