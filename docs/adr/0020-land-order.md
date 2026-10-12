# Land order between issues

Status: accepted for schema 9 and snapshot 7. The production D1 upgrade and Worker deploy wait for owner approval.

## Problem

Two issues can touch the same files without one needing the other to start.
Each one can be started, claimed, and closed on its own, but the second change is easier to rebase when the first one reaches main first.
A prerequisite ([0008](0008-issue-prerequisites.md)) says the wrong thing: it blocks the dependent issue and removes it from the ready worklist.
So the order lived in comments, where no tool could read it.

## Decision

Schema 9 adds a separate relation, `land_order(later_id, earlier_id)`.
It means "`later_id` should reach main after `earlier_id`", and nothing more.

- It never blocks start, claim, or close, and the ready and blocked worklists ignore it.
- It has its own per-issue revision on `later_id` and its own request receipts, like prerequisites.
  `land_order_add` and `land_order_remove` take `expected_revision` and `request_id`; `land_order_list` returns `{issue_id, revision, after, before}`.
- An agent writes land order only for a `later_id` it holds a claim on, the same gate as other agent writes on an issue.
- `show` and `list` add `land_order` only when the request sets `with_land_order`.
  A list returns one entry per issue, in the order of `issues`.

A self-edge, or an edge that closes a cycle, fails with `dependency_cycle`.
The check walks the union of prerequisite edges and land-order edges, and `dependencies_acyclic` walks the same union.
Both kinds say that one issue comes after another, so a cycle through either kind, or through both, has no order that satisfies it.
The check is a trigger, so the rejected write and its receipt leave no row.

### Handoff warning

`claim_handoff` returns `land_order_warnings: [{id, status}]`.
Each entry is a direct predecessor of the handed-off issue that is not closed and has no `main-wait` label.
A closed issue or a `main-wait` issue has reached the queue, so the order holds.
Only direct predecessors count; a predecessor of a predecessor is that issue's own handoff to warn about.

The warning is advisory.
It is read after the handoff commits, so it is not atomic with the handoff, and it never undoes or reorders the push.
The queue skill reports a non-empty list and leaves the decision to a person.

### Revision rows

A revision row exists only after the first edit, and a missing row is revision 1.
So creating an issue writes nothing to the land-order tables, and an import of old snapshots adds no rows.

## Change feed

The change feed gains a nullable `relation` column.
A land-order edge emits `dependency_added` or `dependency_removed` on `later_id` with `relation: "lands_after"`.
A prerequisite event has no `relation`, so earlier readers see the same events as before.
Land order never emits `became_ready`, because it never changes readiness.

## Transports

The new arguments are opt-in, and default responses keep their shape.
An older Worker rejects `with_land_order` as an unknown field, and the cloud client then retries without it and returns no `land_order`.
Released clients ignore `land_order_warnings` and `relation`, because they drop unknown response keys.

## Schema and snapshot

The schema 9 DDL for a fresh store and for an upgraded store is the same text.
Schema 8 is frozen as a literal, so an upgrade from schema 8 compares the store against its exact DDL.
`node scripts/schema.ts --upgrade-from 8` emits the D1 migration, and `pd upgrade` applies the same statements to SQLite.

Snapshot 7 adds `land_order`, `land_order_revisions`, and `land_order_requests`.
`pd snapshot convert --from 6` converts snapshot 6 with empty collections.
Snapshot validation applies the cycle check over the union of both edge kinds, and checks each receipt payload with the operation parser.

## Rollout

Apply the schema 9 migration to D1 before the Worker deploy.
A schema 8 Worker on a schema 9 database keeps working: it ignores the new tables and the `relation` column, and the shared cycle trigger still refuses a prerequisite that would close a cycle through land order.
A schema 9 Worker on a schema 8 database fails every land-order operation and every `with_land_order` read, and the feed read fails because it names the `relation` column.

After a rollback to a schema 8 Worker, land-order events read as prerequisite events, because that Worker does not read `relation`.
The [D1 upgrade procedure](../d1-migration.md#rollback-cost-of-the-schema-9-upgrade) lists these costs for the operator.
