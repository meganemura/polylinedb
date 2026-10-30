# Where an issue was found

Status: accepted for schema 13 and snapshot 11. The production D1 upgrade and Worker deploy wait for owner approval.

## Problem

An agent that finds a problem while it works on an issue files a new issue. Only the prose of that new issue said where it came from, if anything did.
A person could not see what a piece of work surfaced, and a later agent could not trace why an issue exists without reading every body and comment.

## Decision

`create` takes an optional `discovered_from`: the ID of the issue the caller was working on when it found this one. The issue must exist in the same store.
`show` returns `discovered_from` (an issue ID or `null`) and `discovered` (the IDs of the issues found while working on this one, in issue order).
The CLI takes `pd create --discovered-from ID`, and `pd show --human` prints `Found while working on` and `Found here` lines. The `/ui` issue page shows the same two lines in a Found card, each ID a link.

The link records history and holds nothing. It does not change the ready worklist, close, claims, owner waits, or any gate, and either end may close while the other is open.

### Create-only

The link is written in the same batch as the issue and never changes.
It records a fact about the moment of filing: what the caller was doing. A later edit would record a later opinion about that moment, and it would need a version, a conflict rule, a change feed event, and a release shape of its own.
A correction belongs in a comment. If a later need for an editable link appears, an `update` field can add one without changing what is stored here.

### The replay rule

The stored create payload includes `discovered_from` when the request names it, and leaves it out otherwise, so a create without it keeps its released payload.
A retry with the same `request_id` and the same payload returns the same issue. A retry with a different link, or that adds or drops one, is `request_conflict`.

## Options compared

**A column on `issues`.** One nullable column would avoid a table, but every issue row in every list, search, and snapshot would carry it, released clients reject issue keys they do not know, and an `ALTER TABLE` leaves DDL that a fresh schema must copy exactly. Refused.

**Read the link from the create request.** The request receipt already stores the payload, so `show` could read `discovered_from` out of it with no new table.
That makes a replay receipt the source of a domain fact, and the reverse direction would need an expression index over JSON. Refused. The snapshot check below keeps the two in agreement instead.

**A general relation table with kinds.** Nothing else needs a typed relation today, and prerequisites and land order already own their edges and rules. Refused.

**An editable link with versions.** See Create-only. Refused for now.

## Transports

All transports share the operations: the local store, HTTP `/v1/operations`, MCP, and the CLI.
The current client sends `polylinedb-issue-fields: closure, items, discovered`. For a client without the `discovered` token, `show` has neither field, so a released client keeps the body it knows. MCP results always carry both.
An older Worker answers a `create` with `discovered_from` with `invalid_input`. The client asks for a newer Worker and does not retry, because without the field the Worker would file the issue with no record of where it was found.
An older Worker's `show` has neither field, and the client's result then has neither.

## Schema and snapshot

Schema 13 adds `issue_discoveries`, keyed by `issue_id`, with `discovered_from` referencing `issues` and a check that an issue does not name itself, and an index on `(discovered_from, issue_id)` for the reverse read.
Schema 13 is not on main and was never applied, so the table joins the schema 13 additions instead of starting schema 14. A fresh store and an upgrade from schema 12 create it in the same place, so their DDL is identical.
Snapshot 11 adds an `issue_discoveries` collection of `issue_id` and `discovered_from`, ordered by issue. Both IDs must exist, an issue appears once, and each link must agree with the `discovered_from` of the create request that filed the issue, so an imported request still replays.
A snapshot 10 converts with no links. Export, import, historical export, the D1 snapshot operator, the additive merge, and the restored addition all carry the links.

## Rollout

Upgrade the D1 database before deploying the Worker: a schema 13 Worker on a schema 12 database fails every `show` and issue page, because they read `issue_discoveries`.
A schema 12 Worker on a schema 13 database keeps working. It refuses `discovered_from` and shows no links.
[The D1 migration guide](../d1-migration.md#rollback-cost-of-the-schema-13-upgrade) lists the rollback costs.

## Verification

`test/discovery.test.ts` and `test/discovery-d1.integration.ts` run the same flow on SQLite and on local workerd D1: a link from create, both directions on `show`, an unknown source refused with nothing written, the replay rule, both ends ready, claimable, and closable, and the upgrade of a populated schema 12 store.
A Hegel property checks that every issue lists exactly the issues that name it, in issue order.
The snapshot test carries the links through export and import, refuses a broken link or one that disagrees with its request, and converts snapshot 10.
`test/worker.test.ts` checks the `/ui` Found card, `test/cloud-compatibility.test.ts` checks the decoder, the released `show`, and the older-Worker refusal, and `test/cli.test.ts` checks `--discovered-from` and the human lines.
