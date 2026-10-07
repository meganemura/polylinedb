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

Ready issues have status `open`, no active blockers, and no `main-lock` label.
A `main-lock` issue is a repository lock, so the ready worklist leaves it out even when the filter names that label; find it with `pd list --label main-lock`.
Blocked issues have status `open`, `in_progress`, or `deferred`, with an active blocker.
A blocker is active when its status differs from `closed`.
Filters select dependent issues. Worklists observe current state and do not establish exclusive ownership.
An issue can acquire prerequisites in any status. Its stored status does not change when its blockers change.

A requested start or close requires resolved prerequisites. Generic updates apply this rule to their complete field batch.
An explicit exception requires `--force --reason TEXT` on `close` or an update that sets `in_progress` or `closed`.
The reason becomes an attributed comment in the same transaction as the successful status update.
A stale or rejected update creates no exception comment. Reasons use the comment limit of 65536 UTF-8 bytes.
Reopen uses normal status CAS.

HTTP and MCP use `dependency_list`, `dependency_add`, `dependency_remove`, and `dependency_worklist` through the shared operation boundary.
The worklist operation accepts `state: "ready"` or `state: "blocked"` and the same issue filters.
Existing issue results and their seven field versions retain their shapes.

Schema 5 and snapshot 4 preserve edges, aggregate revisions, and immutable request receipts.
Use the [D1 operator procedure](d1-migration.md) for transfers and deployment upgrades.
Review an explicit source-ID mapping before adding prerequisites from another tracker.
Plaintext blocker notes require human interpretation. The importer does not parse them automatically.
