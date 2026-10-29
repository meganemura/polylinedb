# Asks and checks

Status: accepted for schema 12 and snapshot 10. The production D1 upgrade and Worker deploy wait for owner approval.

## Problem

An agent that needed the owner's decision had one way to say so: add the `owner-decision` or `owner-action` label, write the question in a comment, and release the claim.
The label said that the issue waited, but not on what. The question, its options, and the agent's own recommendation lived in free text, and the answer came back as another comment that the agent had to find by reading the issue again.
The agent lost its claim while it waited, so another lane could start the issue, and nothing woke the agent when the owner answered.
An issue also had no place to state what had to hold before it could close. A reviewer read the summary comment and trusted it.

## Decision

An issue carries items. An item is an ask or a check, numbered from 1 on its issue in the order it was added.
Items are never deleted, and each one leaves `open` once.

- An ask is a question for a person: text, optional options (2 to 8 distinct answers), an optional recommended option, and exactly one answer.
  It ends `answered` (the answer and an optional note) or `withdrawn` (a reason).
- A check is an acceptance condition. It ends `met` (a short evidence line) or `waived` (a reason).

Two operations cover every move: `item_add` and `item_resolve`. The CLI has one verb group, `pd item ask|check|answer|meet|waive|withdraw`, whose verbs map onto those two operations.
`show` returns the issue's `items`.

### What an open item holds

One rule table in `src/transition/items.ts` says what each kind holds and who may move it.
An open ask holds the issue out of the ready worklist and holds close. An open check holds close.
The ready worklist, owner waits, and the attention rule read the same condition, so the `/ui` You lane, `dependency_owner_waits`, and `pd ready` agree.
`close` and `claim_handoff` refuse with `items_open` (409) while an ask is open or a check is unmet, and write nothing.
The message names every such item and the command that ends it, and the details carry `{ id, open_items: [{ n, kind, text }] }`, so a caller fixes the refusal in one round trip.
`close --force --reason` bypasses the items the way it bypasses prerequisites, and records the reason comment. `claim_handoff` has no force, as before.
`claim_acquire` reports the open asks as `open_asks`, beside `open_blockers`, and does not refuse.

### Owner labels stay

Existing production issues carry `owner-decision` and `owner-action`.
Those issues have no structured question to convert: the question, when there is one, is in free text, and `owner-action` also marks an issue that is itself the owner's work, which no ask expresses.
So the labels keep their meaning everywhere they act, and an open ask is a second way to wait on the owner.
The ready worklist leaves out an issue with either, owner waits lists an issue with either, and the You lane shows an issue with either.
Agents ask instead of labeling, so new owner waits arrive as asks, and the labels drain as the owner works through the issues that carry them.
No migration rewrites a label, so nothing is dropped silently, and the owner can still add a label by hand.

### Who may move an item

| Move | Who |
| --- | --- |
| Add | Anyone who may write the issue; an agent needs its own active claim |
| Answer an ask | A human actor that did not ask it, or a person on the `/ui` page |
| Withdraw an ask | The actor that asked it, or a human, with a reason; an agent needs its claim |
| Meet a check | Anyone who may write the issue, with evidence; an agent needs its claim |
| Waive a check | A human actor, with a reason |

The store checks the actor kind it is given, and that kind is only as honest as its source.
A local kind is self-declared by `--actor-kind` or `POLYLINEDB_ACTOR_KIND`. A cloud kind comes from the roster role, and an agent host that signs in through OAuth as the owner acts as the owner's human actor.
So "a human answers" alone would let a cloud agent answer its own question.
The rule that the asking actor cannot answer its own ask through an operation closes that path: every host that shares the owner's sign-in shares the actor that asked.
The `/ui` issue page and the You lane answer as the signed-in person even when that actor asked, because the page is the one write path such a host does not reach through its tools.
The page sets this permission in code; no operation input can.
What remains: anything that holds the owner's browser session or a token for the owner can still answer as the owner, and a local process that declares itself human can answer an ask that another actor raised. The store cannot tell either from the owner.

A move from open is a guarded `UPDATE ... WHERE state = 'open'`, so two answers that race leave one answer standing.
The other gets `item_conflict` (409) with the item as it stands. An exact repeat, by the same actor with the same answer and note, returns the item unchanged and writes nothing, so a retry after an uncertain result needs no request ID.
`item_add` takes a request ID. The stored row is the receipt: a replay with the same actor and item returns the item, and a different actor, issue, or item is `item_request_conflict`.

### Waiting for the answer

The change feed gains two kinds: an ask records `asked`, and its answer records `answered`.
A withdrawal, a new check, and a met or waived check record `updated` with `fields: ["items"]`.
When the last open ask of an open issue with no active blocker leaves, the same write records `became_ready` after the answer.
`item_add` returns `wait_from: { incarnation, since }`, the feed position just after the ask.
The asking agent keeps its claim, reports `blocked`, and waits with `kinds: ["answered"]` from that position, so it never wakes on its own question and cannot miss an answer that lands first.
Its lease stays its own while it waits: `claim keepalive` or `claim_renew` keeps it alive.

## Options compared

**Plan steps beside asks and checks.** A list of steps would turn an issue into a task tracker and duplicate the agent's own plan.
Nothing reads a step's state to allow or refuse anything. Refused.

**Asks as a comment convention.** A comment with a marker would keep the schema unchanged, but the ready worklist, the close gate, and the feed would each parse comment text, and an answer would be one more comment with no once-only rule.
Refused.

**Replace the owner labels with asks by migration.** A migration could turn each labeled issue into an ask with the label as its text.
The ask would hold no real question, and `owner-action` issues are not questions at all. Refused; both stay, as above.

**Answer through any human actor.** Simple, but a cloud agent signed in as the owner would answer its own ask. Refused in favor of the asker rule and the page exception.

**A separate answers table.** An item holds exactly one answer, so a second table would only add a join and a uniqueness rule. Refused.

## Transports

All transports share the operations: the local store, HTTP `/v1/operations`, MCP, and the CLI.
The MCP hints of both item tools are `readOnlyHint: false`, `destructiveHint: false`, and `idempotentHint: true`.
A released cloud client rejects details on an error code it does not know and requires an owner label on every owner wait.
The current client sends `polylinedb-issue-fields: closure, items`; for a client without the `items` token, the Worker leaves `items` out of `show` and `open_asks` out of `claim_acquire`, sends `items_open` without details, and lists only labeled owner waits.
MCP results always carry the new fields.
An older Worker answers the item operations and a feed filter on the new kinds with `invalid_input`; the client reports that the Worker needs an update and does not retry.
The `/ui` You lane shows an issue with an open ask as an Answer item with one button per option, the recommended one filled. The issue page lists every item, answers asks, and waives checks with a reason. Both post to `/ui/i/<id>/item`.

## Schema and snapshot

Schema 12 adds the `issue_items` table, keyed by `(issue_id, n)`, with a unique `request_id` and check constraints that tie each state to its answer, note, and resolution.
The `change_events` kind check lists the kinds, so schema 12 rebuilds the table for `asked` and `answered` the way schemas 10 and 11 rebuilt it.
It drops the fifteen triggers that name `change_events`, creates `change_events_v12`, copies every event with its `seq`, renames it, creates the triggers again with their schema 11 text, and adds the two item triggers.
`src/records/persistence/schema-v11.ts` freezes the schema 11 statements for upgrades and tests.
Snapshot 10 adds an `issue_items` collection, ordered by issue and `n`, with each item's request ID. A snapshot 9 converts with no items.
Export, import, historical export, the D1 snapshot operator, the additive merge, and the restored addition all carry the items.

## Rollout

Upgrade the D1 database before deploying the Worker: a schema 12 Worker on a schema 11 database fails every read and write that names `issue_items`, including `show`, `close`, `claim_acquire`, and the ready worklist.
A schema 11 Worker on a schema 12 database keeps working, but it does not see asks or checks.
After the first ask, a rollback to a schema 11 Worker fails each change feed page that holds an `asked` or `answered` event.
[The D1 migration guide](../d1-migration.md#rollback-cost-of-the-schema-12-upgrade) lists the steps and the rollback costs.

## Verification

`test/items.test.ts` and `test/items-d1.integration.ts` run the same flow on SQLite and on local workerd D1: the agent gate on adds, the ready worklist and owner waits, `open_asks` on a replayed acquisition, each refused answer, the close and handoff refusal with its details, two racing answers with one left standing, the feed order, the force path, a withdrawal, and the upgrade of a populated schema 11 store with every event at its seq.
Hegel properties check the move rules against the rule table, and that any mix of concurrent answers and withdrawals leaves an ask open at most once with one event.
`test/worker.test.ts` checks the MCP hints and the `/ui` answer and waiver, `test/cloud-compatibility.test.ts` checks the client decoders and the released shapes, and the snapshot and D1 operator tests carry items through every transfer.
