# Separate issue transitions from storage and cross-issue rules

Status: accepted for the layers and the release 0.5 authority. The rest stays proposed until its open question closes.

## Problem

The issue module decides each change inside conditional SQL.
SQLite and D1 run the same statements, so the two stores agree.
D1 cannot run a decision in code between a read and a write in one transaction.
A Durable Object with SQLite storage can, through `ctx.storage.transactionSync`.

Nine rules read more than one issue or a value of the whole store.
The [issue authority design](../issue-authority.md#the-cross-issue-port-owns-facts-that-span-issues) lists them and where the code enforces each rule today.
A cloud store that splits issues into separate objects must keep these rules without a shared transaction.

## Decision

Split issue behavior into three layers and one port:

- A pure transition decides one issue change from the state, the command, the actor, the time, and the port's answers.
- A per-issue write layer applies one decision to one issue and records a signal.
- A cross-issue port owns edges, containment, counters, creation receipts, claim request IDs, and the store incarnation, and it answers the checks that depend on them.
- A search layer answers list, search, ready, blocked, claim list, and dependency list.

These parts are module boundaries.
One issue is the unit of change for the per-issue write layer.
The port owns every rule that reads other issues, and no issue authority holds those rules.

Release 0.4 adds the transition.
Both stores keep conditional SQL, and the transition classifies rejections and specifies the SQL conditions through a differential test.

For release 0.5, the cloud store uses one Durable Object for the whole store.
The object keeps the current schema, including memories, and runs each mutation inside `transactionSync`.
The transition, the per-issue write, and the port then share one transaction, as they do in the local file.
D1 keeps a projection that a sequenced outbox fills, for a return to D1 and later read offload.
The owner chose this option over per-issue authorities for release 0.5.

The stored state is the truth.
A signal carries the full row and a sequence number, and D1 applies only a greater sequence.
Claims expire by the deadline comparison at each write.
The Durable Object alarm only drives outbox delivery.

The store object's name contains the store incarnation.
The migration from D1 and the return to D1 are snapshot restores into a new object or a new database, and each restore rotates the incarnation.
Claims end at each switch, and memory observations report `stale` with the reason `store_changed`.

The boundary configuration adds a `core` layer below `domain` for `src/transition/`.
It adds `issue-authority`, `cross-issue-port`, and `projection` capabilities.
The issue authority may import the transition and the public entry of the port.
The port and the projection may import the transition.

## Consequences

The local store keeps one SQLite file and one transaction for every rule.
Its behavior does not change.

With one store object, every public read and write goes to that object.
List after write shows the write, as it does on D1 today, and the request and response shapes stay the same.
Every mutation passes through one object with a soft limit of about 1,000 requests per second.

This decision changes the statement in the [architecture](../architecture.md) that the issue module keeps validation and SQL together.
After release 0.4, the transition holds the decisions, and the SQL holds the storage plan.
The ordered `SqlExecutor` contract from the [capability decision](0006-capability-boundaries.md) stays for D1 and SQLite.

## Alternatives

Per-issue authorities with a separate port let edits that need no cross-issue answer scale with the number of issues.
Start, close, reopen, type change, creation, and every claim mutation still pass through one port, which has the same single-writer limit as one store object.
The port must keep a mirror of the closed and epic facts of each issue without a shared transaction.
Two adversarial reviews of that mirror protocol found defects that let a dependent close while its blocker was active.
The design records the proposed fixes as unverified rules and gates a split on a measured need and a passing interleaving model.

Per-issue authorities that check cross-issue rules against the D1 projection admit operations from old facts.
An old projection could then allow a close while a blocker is active again.

D1 as the authority with the transition only as a specification keeps the current deployment.
It keeps conditional SQL as the place that enforces each rule in the cloud.

Carrying claims across a switch needs an exception to the rule that a transfer invalidates imported authority.
The design keeps the rule.

## Open questions

1. Does the outbox sender use the Durable Object alarm or a Cloudflare Queue? The alarm needs no extra service. A queue separates delivery retries from the store object.
2. Which limits start a return to D1 as the authority? The design names the failure classes, and the owner sets the numbers.
3. What request rate and store size does the personal store reach? Measure both before release 0.5.
4. Do the generated list, search, and claim queries return the same results on Durable Object SQLite storage? Run the contract tests in a local workerd process.
5. Can archstrict keep a deny rule for a module that has no outgoing edges? Until it can, the configuration cannot deny `solarsql` to `src/transition/` directly.
