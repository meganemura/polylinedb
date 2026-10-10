# Record a store-wide change feed

Status: accepted for release 0.5 preparation. The lease-expiry event waits for the reclaim alarm of the store Durable Object.

## Problem

An agent that waits for another agent's work polls `show`, `list`, or the ready worklist.
Polling repeats whole reads and still misses short-lived states between two reads.
The waiting operations planned after this change need an ordered record of what changed.

The [issue authority design](../issue-authority.md#stored-state-is-the-truth-and-signals-report-changes) keeps the stored state as the truth.
A change report must therefore only say that something changed, and a receiver must read the state again.
The report must be written in the same transaction as the change, on SQLite and on D1, so a rejected write reports nothing.

`SqlExecutor.batch` runs a fixed list of statements.
D1 cannot read an old row, decide in code, and then write in the same transaction.
`became_ready` needs the old status of a blocker, and `updated` needs the names of the fields that a write changed.

## Decision

### One table, written by schema triggers

Schema 7 adds two tables:

- `change_events` holds one row per event: `seq`, `issue_id`, `kind`, `fields_json`, `occurred_at`, and `actor`.
- `change_writer` holds at most one row with the actor of the current mutation batch.

Triggers on `issues`, `comments`, `claim_requests`, and `dependencies` insert the events.
A trigger sees the old and the new row, so it can name the written fields and see a blocker's previous status.
Each trigger runs inside the statement that changed the row, so the event commits or rolls back with the change.
The local store and D1 run the same DDL, so the same statements record the same events on both stores.

Every issue, comment, claim, and prerequisite mutation batch starts with an insert into `change_writer` and ends with its deletion.
The triggers fire only while that row exists, and they take the actor from it.
Snapshot import, the D1 restore and merge operators, and schema upgrades write rows without that row, so they record no events.
A leftover row would make the next batch fail on the `change_writer` primary key, so a missing deletion cannot go unnoticed.

The Durable Object store in the [authority decision](0011-issue-authority-layers.md) runs the same DDL in `transactionSync`.
The triggers then record events in that transaction without a change to this decision.

### The sequence comes from the row ID

`seq` is the `INTEGER PRIMARY KEY` of `change_events`, without `AUTOINCREMENT`.
SQLite and D1 give a new row the largest existing `seq` plus one, and the first row gets 1.
A trigger that inserts several rows inserts them in the order of its `SELECT`, so they get consecutive numbers.

The sequence has no gaps and no repeats within one store incarnation:

- A rejected write changes no row, so no trigger fires and no number is taken.
- A batch that fails rolls back as one transaction, D1 batches included, so its numbers are free again for the next committed batch. Nobody outside the transaction saw them.
- SQLite and D1 serialize write transactions, so two batches never take the same number.
- Retention deletes only the oldest rows and always keeps the newest, so the largest `seq` never decreases.
- A rotation of the store incarnation deletes every event, and the next event gets `seq` 1. The cursor names the incarnation, so a reused number cannot be confused with an old one.

### Kinds

| Kind | Recorded when | `fields` |
| --- | --- | --- |
| `created` | `create` inserts an issue | `[]` |
| `updated` | `update` writes fields without `status` | Written fields in schema order |
| `status_changed` | `update`, `close`, or `reopen` writes `status` | Written fields in schema order, including `status` |
| `commented` | `comment`, or a forced status change, appends a comment | `[]` |
| `claim_acquired` | `claim_acquire` commits a receipt | `[]` |
| `claim_released` | `claim_release` commits a receipt | `[]` |
| `dependency_added` | `dependency_add` inserts an edge; `issue_id` is the dependent | `[]` |
| `dependency_removed` | `dependency_remove` deletes an edge; `issue_id` is the dependent | `[]` |
| `became_ready` | A blocker closes, or an active blocker is removed, and the dependent is `open` with no active blocker left | `[]` |

A written field counts even when its value stays the same, because the field version advances.
A forced close records `status_changed`, then any `became_ready` events, then `commented` for the reason.
`became_ready` uses the ready definition in `CONTEXT.md`: an `open` issue with no active blocker.
A blocker that was already closed releases nothing, so a repeated close records no `became_ready`.
A dependent with two active blockers records `became_ready` only when the second one closes or is removed.
The events of one batch take consecutive numbers in statement order, and `became_ready` events follow the issue order.

These writes record no event:

- A rejected write, and a request replay. Creation replay inserts nothing; claim and prerequisite replays fail on the receipt key and roll back before the stored receipt is returned.
- `claim_renew`. A renewal extends the deadline for the same holder and changes no ownership or issue state. An agent renews every few minutes, so renewal events would crowd out the other kinds within the retention window. `claim_show` reports the current deadline.
- A prerequisite edit with the outcome `already_present` or `already_absent`. The edge set does not change.
- Memory operations. The feed is about issues, and memories keep their own revisions and freshness.

### A lapsed lease records no event yet

A lease that passes its deadline has no writer at that moment.
An event derived at read time from `expires_at` has no stored position in the sequence.
Two readers at different times would then see different sequences, and a page could not promise that it has no gaps or repeats.
This decision therefore chooses the event that the reclaim role of the store alarm writes with `reclaimed_at`, in the same `transactionSync` as that write.
That kind arrives with the reclaim alarm.
Until then, a caller reads `expires_at` from `claim_show` and `claim_list`, which report the state `expired` at their read time.

### Retention keeps the newest 10,000 events

A trigger on `change_events` deletes the events that are 10,000 or more numbers older than the new one.
The count bounds storage and the D1 rows written: in steady state each event deletes one old event.
A receiver that falls more than 10,000 changes behind reads the state again.
A count does not depend on the clock, so both stores and the tests keep the same rows.
The bound is one constant in the schema and can change with a later schema version.

### The cursor names the incarnation

`changes` takes `since`, an integer from 0, and `incarnation`, which is required when `since` is greater than 0.
It returns the events with `seq` greater than `since`, in order, the current `incarnation`, and `next_since`.
When more matching events remain, `next_since` is the `seq` of the last event on the page.
Otherwise `next_since` is the newest `seq` in the store, so the next read skips events that the filters excluded.
The read takes the page and the bounds in one query, so a write between two reads cannot open a gap.

The read fails in these cases:

| Code | Status | Cause | Details |
| --- | --- | --- | --- |
| `incarnation_mismatch` | 409 | `incarnation` names another store incarnation | `incarnation`, `next_since` |
| `cursor_expired` | 409 | Retention removed events after `since` | `incarnation`, `next_since` |
| `invalid_input` | 400 | `since` is greater than the newest `seq` of the incarnation | None |

The details name the current incarnation and the newest `seq`.
After either 409 error the caller reads the state it needs again, and then continues with those values.
Changes after the new cursor appear in the feed, and the state read covers the changes before it.

The project filter matches the current project of the issue, because events do not copy issue fields.

### The feed and the per-issue outbox stay independent

The outbox in the [issue authority design](../issue-authority.md#signals-use-an-outbox-and-the-projection-ignores-old-sequences) numbers changes per issue and carries the full row for the D1 projection.
The projection applies only a greater sequence for each issue, and the sender deletes an outbox row after delivery.
The feed numbers changes for the whole store, carries no row, and keeps a fixed window for receivers that read the state again.
Neither sequence is derived from the other.
When the store Durable Object lands, one transaction writes both.

### Snapshots carry neither the feed nor its sequence

Every restore path rotates the store incarnation: `pd import`, the D1 restore operator, and the raw restore procedure.
A rotation empties the feed, and every old cursor then fails with `incarnation_mismatch`.
A carried next sequence would give a receiver nothing, because its cursor is invalid after the rotation either way.
Snapshot 5 therefore stays unchanged, and this decision needs no snapshot conversion.
A later snapshot version can add the next sequence if a receiver needs one.

### Compatibility

`changes` is a new operation for the CLI, HTTP, and MCP, with read-only MCP hints.
Every existing request and response keeps its shape.
The cloud client checks `kind` as a lowercase name instead of a fixed list.
A later kind, such as the reclaim event, then reaches released clients without `cloud_invalid_response`.
Every event carries `fields`, which is empty for kinds without field names.

## Consequences

A mutation batch writes two more rows for the writer, one row per event, and about one deleted row per event after the window fills.
D1 counts these as rows written.

A Worker at this version fails every write against a schema 6 database, because `change_writer` is missing.
Upgrade D1 with `node scripts/schema.ts --upgrade-from 6` before deploying the Worker.
A schema 6 Worker keeps working against an upgraded database, and its writes record no events.

An operator restore or merge records no events.
A receiver sees a restore as an incarnation change.
After a merge into a live store, a receiver must read the merged issues itself.

## Alternatives

Statements in each batch could insert the events after the write, gated by `changes()`.
The write statement cannot report the old row, so `became_ready` would need the old status from a statement before the write.
A claim condition compares deadlines with the database clock, which can move between two statements.
The earlier statement could then record an event for a write that the later statement rejects.

`AUTOINCREMENT` would also prevent reuse after deletions, but it adds the internal `sqlite_sequence` table to the schema that the restore operators compare.
The retention rule already keeps the newest row, so the row ID alone is enough.

An age-based retention needs a clock decision at every write and makes the retained set depend on the time of each test run.
