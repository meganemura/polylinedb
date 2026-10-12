# External resources on an issue

Status: accepted for schema 9 and snapshot 7. The production D1 upgrade and Worker deploy wait for owner approval.

## Problem

Work on an issue can create things outside the store: a preview database, a Worker, a bucket, a DNS record.
When the issue closed, nothing recorded what was left behind, so cleanup depended on someone remembering.
A comment can name a resource, but no tool can tell whether it was removed, and nothing stops the close.

## Decision

Schema 9 adds `issue_resources`, a list of entries on an issue, with its own per-issue revision and request receipts.
An entry has a free-form `kind`, such as `d1:database`, a `name`, and an optional `external_id`.
These are identifiers only. The store refuses whitespace and control characters, and the documentation says never to record a secret, a token, or a URL with credentials.

| Field | Rule |
| --- | --- |
| `kind` | `^[a-z0-9][a-z0-9:._-]{0,63}$` |
| `name`, `external_id` | 1 to 256 UTF-8 bytes, no whitespace or control characters |
| `evidence` | 1 to 1024 UTF-8 bytes |

An invalid value fails with `invalid_input` before any write.

### Marks

An entry starts `planned`, so an agent records it before it creates the resource and a crash in between still leaves a record.
`resource_update` sets `external_id` once and moves the entry forward with a mark:

- `planned` to `created` to `deleted` to `verified_deleted`.
- `planned` straight to `verified_deleted`, for a resource that was never created.

A mark never moves back and is set once. The store clock sets each timestamp, so a caller cannot backdate one.
A trigger refuses any other change to a row, and no entry is deleted, so the table is the history of the issue's resources.

`verified_deleted` needs `evidence`, which says how the deletion was checked, and a current claim proof on the issue from every actor, the owner included.
Verification ends the obligation the entry stands for, so it needs the same proof as the other writes that end work on an issue.

An entry is live until `verified_deleted`. A `deleted` entry is still live, because a delete call that returned is not proof that the resource is gone.

### Close guard

`close`, and an `update` that sets status `closed`, fail with `resources_remaining` while the issue has a live entry.
The message names up to five live entries as `kind:name` and says how many more there are.
The error has no details, so released cloud clients decode it: they accept an unknown error code at 409 only when it carries no details.
The CLI reads `resource_list` after the refusal and reports the live entries in the error details.

A nonempty `resources_reason` closes anyway and is stored as a comment by the closing actor, in the same batch as the status write.
`force` does not bypass the guard: it answers for prerequisites, and a resource that is still running is a different question.
An epic answers only for its own entries. A child's entries keep the child open, not the epic.

The transition decides the guard after `dependency_blocked`, from an observed `has_live_resources`, and the conditional `UPDATE` carries the same condition.
The transition differential compares both on SQLite and D1.

## Reads

`resource_list` returns `{ issue_id, revision, resources }`, each entry with its derived `state`.
`resource_live` returns `{ entries, next_cursor }`: the issues that still have live entries, in issue order, each with those entries, filtered by `tool` and `project`.
A cleanup pass reads `resource_live` instead of every issue.

## Change feed

Each committed entry change records `updated` on the issue with `fields: ["resources"]`.
A replay or a rejected write records nothing.

## Transports

Default responses keep their shapes.
An older Worker rejects `resources_reason` and the resource operations as unknown input.
The cloud client does not retry a close without `resources_reason`, because an older Worker would then close without recording a reason; it reports that the Worker needs an update.

## Schema and snapshot

The resource DDL is part of schema 9, after the land order of [0020](0020-land-order.md), on a fresh store and an upgrade alike.
Snapshot 7 carries `issue_resources`, `resource_revisions`, and `resource_requests`, and a snapshot 6 converts with empty collections.
Snapshot validation checks each entry, its mark order, its timestamps, and each receipt payload with the operation parser.

## Rollout

The D1 rollout is the schema 9 rollout in [0020](0020-land-order.md#rollout).
A schema 9 Worker on a schema 8 database also fails every `update`, `close`, and `reopen`, because the issue write reads `issue_resources`, so the database upgrade comes first.
A schema 8 Worker on a schema 9 database ignores the resource tables, so it closes an issue without the guard.
After a rollback, `resource_live` shows what such closes left behind once a schema 9 Worker returns.
