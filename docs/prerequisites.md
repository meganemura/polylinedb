# Issue prerequisites

A dependency points from the dependent issue to its blocker.
Both issues belong to the selected store. They can belong to different projects.
Epic children describe containment independently from prerequisites.

Read the current aggregate revision before a mutation:

```sh
pd dependency list demo-1
pd dependency add --dependent demo-1 --blocker demo-2 --expected-revision 1 --request-id 11111111-1111-4111-8111-111111111111
pd dependency remove --dependent demo-1 --blocker demo-2 --expected-revision 2 --request-id 22222222-2222-4222-8222-222222222222
```

Named endpoint flags establish the direction. Numeric IDs use the selected prefix, including child numbers.
`dependency list` accepts `--after ID` and `--limit 1..100`. The default limit is 50.
Blockers use numeric ID order. A returned cursor selects the next page.

A new issue starts at revision 1, so revision 1 means that its prerequisites were never edited.
Each accepted fresh request advances the dependent revision once, including duplicate adds and absent removes.
Stale requests return `dependency_conflict`, including a current first page from the mutation transaction.
Reread and reconsider the mutation. Do not silently refresh its expected revision.
The request UUID identifies one logical mutation. Retain its UUID and original payload for an explicit retry.
A retry returns the original revision and outcome, even after another request removes that edge.
A different actor or payload under that UUID returns `dependency_request_conflict`.
The CLI generates an omitted UUID once and returns it when a cloud outcome is unknown.
API and MCP callers must supply it. Fresh UUIDs cannot increase a revision at its safe integer limit.

Self-links and cycles fail atomically. Failed mutations leave the graph, revision, and request ledger unchanged.
Edges persist after a blocker closes. A later reopen can activate that prerequisite again.

```sh
pd ready --project demo
pd blocked --tool compiler --project demo --after demo-10 --limit 50
```

Ready issues have status `open`, no active blockers, no `main-lock` label, and neither the `owner-decision` nor the `owner-action` label.
A `main-lock` issue is a repository lock, so the ready worklist leaves it out even when the filter names that label; find it with `pd list --label main-lock`.
An issue that waits on an owner decision or action leaves the ready worklist for every actor, because no agent should start it and a human should not mistake it for open work.
Naming one of those labels in the filter does not bring the issue back; list owner waits as described below.
Blocked issues have status `open`, `in_progress`, or `deferred`, with an active blocker.
A blocker is active when its status differs from `closed`.
Filters select dependent issues. Worklists observe current state and do not establish exclusive ownership.
An issue can acquire prerequisites in any status. Its stored status does not change when its blockers change.

A requested start or close requires resolved prerequisites. Generic updates apply this rule to their complete field batch.
An explicit exception requires `--force --reason TEXT` on `close` or an update that sets `in_progress` or `closed`.
The reason becomes an attributed comment in the same transaction as the successful status update.
A stale or rejected update creates no exception comment. Reasons use the comment limit of 65536 UTF-8 bytes.
Reopen uses normal status CAS.

## Owner waits

The labels `owner-decision` and `owner-action` mark an issue that waits on the owner.
The store has no owner identity, so "owner" means any human.
An agent may add one of these labels as a handoff: set the status to `open`, add the label with the proof as a comment, and release the claim.
The labels act through the ready worklist only. `claim_acquire` still follows [the agent gate](claims.md#gate-agent-work), so an agent must not claim an owner wait by ID.
`main-wait` is not an owner wait. It means the work sits in the land queue and is not yet on main, and it does not leave the ready worklist.

```sh
pd owner-waits --project demo --limit 50
```

`owner-waits` returns each unfinished issue that carries either label, in ID order, with its direct unfinished dependents.
Each entry has `issue`, `dependents` (`id`, `project`, `status`, at most 50, in ID order), and `dependents_next`, which is the last returned dependent ID when more exist and otherwise `null`.
Only direct dependents are reported, as in `dependency list`. Filters are `--tool`, `--project`, `--after`, and `--limit 1..100` (default 50).
The change feed is unchanged: adding or removing an owner label appears as an `updated` event, and `became_ready` still fires only when the last active blocker closes or is removed.

Existing issues need no migration. They carry the same labels, and an issue that holds `ready` together with an owner label leaves the ready worklist when this version is deployed.
Audit them with `pd list --label owner-decision` and `pd list --label owner-action`.
A claim that an agent already holds stays in force; the owner releases it or waits for expiry.

HTTP and MCP use `dependency_list`, `dependency_add`, `dependency_remove`, `dependency_worklist`, and `dependency_owner_waits` through the shared operation boundary.
The worklist operation accepts `state: "ready"` or `state: "blocked"` and the same issue filters.
Existing issue results and their seven field versions retain their shapes.

Schema 5 and snapshot 4 preserve edges, aggregate revisions, and immutable request receipts.
Use the [D1 operator procedure](d1-migration.md) for transfers and deployment upgrades.
Review an explicit source-ID mapping before adding prerequisites from another tracker.
Plaintext blocker notes require human interpretation. The importer does not parse them automatically.
