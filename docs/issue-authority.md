# Issue authority with Durable Objects and a D1 projection

Status: proposed design. The cloud store uses D1 as its authority through `src/service/d1.ts`.

This document describes how the cloud store can move its authoritative state into a Durable Object.
D1 then keeps a projection of that state, and the local SQLite store keeps working as it does today.
The [authority decision](adr/0011-issue-authority-layers.md) records the choices that this design makes and the open questions.

Cloudflare figures in this document come from the official documentation pages, read on 2026-10-06.
Check the pages again before you use a figure for a commitment.

## Purpose and non-goals

The goal is one fixed transition core that the local store and the cloud store share.
The transition core decides every issue change from the observed state and the command.
Today the SQL statements decide each change in their `WHERE` clauses.
The local store and D1 run the same statements, so they agree.

D1 runs a batch of statements as one transaction, and code cannot decide between the read and the write.
A Durable Object with SQLite storage runs a synchronous callback as one transaction with `ctx.storage.transactionSync`.
The cloud store can then read the state, run the transition, and write the result in one transaction.
The transition becomes the only place that decides a change, and the cloud write path no longer needs conditional SQL.
That is the main gain of a Durable Object over D1 as the authority.
The Durable Object alarm also gives the store a timer for outbox delivery.

The design has these non-goals:

- Users cannot supply transition code. The product defines every transition.
- Events do not define the state. The stored state is the truth, and an event only reports a change.
- The CLI, HTTP, and MCP request and response shapes stay the same.

## Stored state is the truth, and signals report changes

Each store keeps the current issue state, its field versions, its claim, and its receipts.
That stored state answers every question about an issue.
When the state changes, the writer also records a signal in the same transaction.
A signal tells a projection that an issue changed and gives the new sequence number.

A receiver uses a signal to update its copy.
A receiver never derives the truth by replaying signals from the start.
If a receiver loses signals, it reads the current state again from the authority.
A lost signal therefore delays a receiver and leaves the stored state correct.

## Three layers and one cross-issue port

The design has three layers.
A fourth part, the cross-issue port, sits beside the per-issue write layer.

| Part | Responsibility | Data it owns or reads | Data it never writes |
| --- | --- | --- | --- |
| Transition | Decide one issue change | Issue state, command, actor, time, and port answers in; decision out | Any storage |
| Per-issue atomic write | Read one issue, apply its decision, and record its signal | One issue's fields, comments, claim, claim receipts, and outbox rows | Port facts |
| Cross-issue port | Own facts that span issues and answer the checks that depend on them | Edges, containment, counters, creation receipts, claim request IDs, and the store incarnation | Issue fields and claims |
| Cross-issue search | Answer list, search, ready, blocked, and claim list | Issue rows and edges, read only | Any authoritative state |

The parts are module boundaries.
They do not decide where each part stores its rows.
In the local store and in the cloud store for release 0.5, all four parts run in one transaction on one SQLite database.
[The per-issue split](#a-per-issue-split-stays-gated-after-05) is the later stage where the parts run in separate objects.

### Transition decides one issue change

The transition is a pure function.
It takes the issue state, the command, the actor, the current time, and the answers of the cross-issue port.
It returns a decision.
An accepted decision contains the new field values, the new versions, the claim change, the receipt, and the signal.
A rejected decision contains the same error code and details that the operations return today, such as `conflict`, `claim_required`, `dependency_blocked`, `epic_has_children`, or `invalid_input` for a parent that is not an epic.

The time is an input.
Today claim statements read the database clock with `unixepoch()`, and issue timestamps come from `new Date()` in the application.
The caller reads its clock once inside the transaction and passes the value to the transition.
The transition stays deterministic, and a test can fix the clock.

### Per-issue atomic write commits one issue

The per-issue write layer applies one decision to one issue.
It writes the issue fields, the claim, the receipt, and the outbox row together.
One issue is the unit of change for this layer.
An operation that depends on another issue also needs an answer from the cross-issue port.

### The cross-issue port owns facts that span issues

Some rules read more than one issue or a value of the whole store.
The current code checks each of these rules inside one SQLite or D1 transaction:

| Rule | State that the rule reads | Current enforcement |
| --- | --- | --- |
| Start or close needs no active blockers | Dependency edges and blocker statuses | The inline `NOT EXISTS` condition in `update()` in `src/records/issues.ts` |
| A dependency graph has no cycle | All edges | The `dependencies_acyclic` trigger in `src/records/schema.ts` |
| Both ends of a dependency exist | Two issues | The admission condition in `src/records/dependencies.ts` |
| An epic with children stays an epic | Children of the issue | The `epic_has_children` guard in `update()` in `src/records/issues.ts` |
| A child needs an epic parent | The parent's type | The `create` batch in `src/records/issues.ts` |
| Numbers are never reused | The counter for a prefix or a parent | The `counters` table and the `create` batch |
| A creation request has one result | The creation receipt for the request ID | The `requests` table and the `create` batch |
| A claim request ID has one result in the store | All claim receipts | The `claim_requests` primary key in `src/records/claims-sql.ts` |
| A claim proof names the current store | The store incarnation | `memory_store_identity` in the claim guard in `src/records/claims-sql.ts` |

The port owns these rules.
The per-issue write layer asks the port for each answer that a decision needs, such as "the issue has no active blockers".
The port reads the current rows of other issues to answer.
When the port and the issue write share one transaction, the answer and the write see the same state, as they do today.

### Cross-issue search reads many issues

List, search, ready, blocked, claim list, and dependency list read many issues.
The search layer reads the authority's rows and never writes them.

## Local SQLite keeps one file, and the cloud keeps one Durable Object

The local store keeps one SQLite file.
That file is the authority, the cross-issue port, and the search index at once.
One `BEGIN IMMEDIATE` transaction covers the issue write and every cross-issue check.

The cloud store for release 0.5 also keeps every part in one SQLite database and one transaction.
One Durable Object holds the whole store in its SQLite storage, with the current schema, including memories.
The Durable Object runs each mutation inside `transactionSync`, so no other request runs between the read and the write.
D1 holds a projection of the store for a return to D1 and for later read offload.

| Part | Local store | Cloud store in release 0.5 |
| --- | --- | --- |
| Transition | `src/transition/` | `src/transition/` |
| Per-issue atomic write | The SQLite file | The store Durable Object |
| Cross-issue port | The SQLite file | The store Durable Object |
| Cross-issue search | The SQLite file | The store Durable Object |
| Projection | None | D1 |

Both stores call the same transition module.
The two stores share every decision and differ only in how they store rows.

One Durable Object has a soft limit of about 1,000 requests per second.
Every mutation of the store goes through that one object.
This design assumes that a personal store stays far below that limit.
The request rate is not measured yet, so measure it before release 0.5.

## Public contract stays the same, and ready stays a candidate list

The CLI flags, HTTP requests, MCP tool schemas, result shapes, and error codes stay the same.
In release 0.5, every read and every write goes to the store Durable Object.
A list after a write therefore shows the write, as it does on D1 today.
The D1 projection serves no public read in release 0.5.

The current list, search, and claim queries are SQLite statements that solarsql generates.
The Durable Object runs them on SQLite storage.
Run the contract tests against a store Durable Object in a local workerd process before release 0.5, to prove that each query returns the same results there.

A ready issue stays a candidate.
A caller that starts work on a ready issue still needs a claim and a status write.
Those writes check the current state, so a ready list that is old by the time the caller acts cannot cause a wrong status change.

## Claims keep leases, and expiry needs no alarm

Claims keep the current contract.
The proof has the issue ID, the store incarnation, the session UUID, and the generation.
The transition compares the proof, the actor, and the deadline with the clock reading at each write.
Equality with the deadline means expiry, as it does today.

No part of the claim lifecycle needs an alarm.
The deadline comparison at the write rejects an expired proof.
The claim list derives `expired` at read time from `expires_at` and the read time.
The projection keeps that derivation, so an expired claim shows as expired in D1 without a new signal.

The Durable Object alarm only drives outbox delivery.
Each Durable Object can have one pending alarm, and `setAlarm()` replaces the previous alarm.
Alarms run at least once.
When the handler throws, Cloudflare retries it with exponential backoff and a limited number of retries.
The handler therefore catches each delivery error and calls `setAlarm()` for the next attempt itself.
A late or repeated alarm can delay the projection.
It cannot change a claim, because the write path never reads the alarm.

## Actor, session, incarnation, and proof fencing stay in the transition

The authenticated actor still comes from the verified Cloudflare Access assertion.
The session UUID still separates sessions that share one actor.
The request UUID still identifies one logical mutation for replay.

The store incarnation stays in `memory_store_identity`, and every proof names it.
The store Durable Object's name contains the incarnation, for example `idFromName("store:" + incarnation)`.
The Worker keeps the name of the current object in its configuration.
A restore into a new object rotates the incarnation, as a restore does today.
The old object then receives no requests.
The projection rejects a signal from another incarnation, and an old object deletes its alarm when it receives that answer.
Every memory observation reports `stale` with the reason `store_changed` after a rotation, as it does after a restore today.

A status write needs the current proof after the claim lifecycle starts.
The transition makes that check, so the local store and the cloud store reject the same proofs.

## Signals use an outbox, and the projection ignores old sequences

The store Durable Object writes each signal into an outbox table in the same transaction as the change.
Each signal carries the store incarnation, the issue ID, a sequence number, and the full projected row for that issue.
The sequence number increases by one for each committed change to the issue.
A change to dependency edges sends a signal with the full edge set of the dependent and its own sequence.

The sender delivers outbox rows to D1.
The sender can be the Durable Object alarm or a Cloudflare Queue.
Both deliver at least once, so D1 can receive a signal twice or out of order.
D1 applies a signal only when its sequence is greater than the stored sequence for that issue or edge set.
Because the signal carries the full row, D1 does not need the signals in between, and a repeated signal changes nothing.
The sender deletes an outbox row only after D1 confirms that it stored that sequence or a later one.

## Cold reconciliation targets zero missed revocations first

A missed revocation is a case where the projection shows authority that the store already removed.
An example is a released claim that the projection still shows as active.
The first correctness target for reconciliation is zero missed revocations after the lag budget.

Cold reconciliation compares the store Durable Object with the D1 projection.
It walks the issue IDs in pages and compares the sequence of each issue and each edge set.
A gap starts a repair that copies the current row.
It also checks that the store has a pending alarm whenever outbox rows wait.

Operators need these measures to decide when the projection is complete:

- The projection lag per issue, as a sequence gap and as an age in seconds.
- The number of outbox rows waiting and the age of the oldest row.
- The number of repairs by class: a missing signal, an old projection row, a missing alarm, and a missed revocation.
- The number of reconciliation runs that failed, with the failure class.

A reconciliation run counts as done when every issue and edge set has a zero sequence gap and the run reported zero missed revocations.
In release 0.5, the projection serves no public read, so the lag affects only the return path.

## Cost and limits come from requests, rows written, and the projection

These figures come from the Cloudflare pricing and limits pages for the Workers Paid plan:

| Item | Durable Objects | D1 |
| --- | --- | --- |
| Requests | 1 million a month included, then $0.15 per million | Billed through the calling Worker |
| Rows written | 50 million a month included, then $1.00 per million | 50 million a month included, then $1.00 per million |
| Rows read | 25 billion a month included, then $0.001 per million | 25 billion a month included, then $0.001 per million |
| Storage | 5 GB-month included, then $0.20 per GB-month | 5 GB included, then $0.75 per GB-month |
| Size limit | 10 GB per object | 10 GB per database |

Durable Objects also bill duration at $12.50 per million GB-s after 400,000 GB-s a month.
An alarm invocation counts as a request, and each `setAlarm()` counts as one row written.
One Durable Object has a soft limit of about 1,000 requests per second.
Queues bill $0.40 per million operations after one million a month, and one message takes about three operations.

One mutation in the cloud store causes this work:

1. One request to the store Durable Object, with its rows written for the change, the receipt, and the outbox row.
2. One `setAlarm()` when outbox rows wait.
3. One projection write in D1 for each delivered signal.

Each read is one request to the store Durable Object with its rows read.
Reconciliation adds the rows read on both sides in each run.

These are the cost drivers.
The design does not estimate a total, because the request rate of a personal store is not measured.
Before the cloud release, measure the requests per month and the rows written per operation in a local workerd run, then compare them with the included amounts.
The 10 GB limit applies to the whole store in one object, and the current store size is far below it, by inference from the issue and memory counts.

## Failure modes keep a path back to D1 as the authority

D1 stays the authority until the Durable Object store passes the release checks.
After the switch, the design keeps a way back.

These failure classes start a return to D1 as the authority:

- The store Durable Object is unavailable for longer than the agreed limit.
- Reconciliation reports a missed revocation that the repair does not remove.
- A transition gives a different decision in the cloud store than in the local store for the same state and command.
- The measured cost exceeds the agreed limit.

The existing restore tooling requires an empty destination.
The return therefore restores a complete snapshot into a new D1 database:

1. Stop writes at the Worker.
2. Export a snapshot from the store Durable Object and validate it with `parseSnapshot`.
3. Restore it into a new, empty D1 database with the existing restore tooling. The restore rotates the store incarnation.
4. Switch the Worker routing to the new D1 database and start writes again.

The old Durable Object receives no requests after the switch.
Delete it after the return proves stable.
The D1 projection is a warm copy for this path, and an operator can compare it with the exported snapshot before step 3.

## Migration from D1 to the store Durable Object moves authority once

The migration moves authority from D1 to one store Durable Object.
It does not run two writable authorities at the same time.

1. Stop writes at the Worker.
2. Export a snapshot from D1 and validate it with `parseSnapshot`.
3. Restore the snapshot into a new store Durable Object. The restore rotates the store incarnation, and the object's name contains the new value.
4. Compare the store with the snapshot by canonical digest.
5. Fill the D1 projection from the store.
6. Switch the Worker routing to the store Durable Object and start writes again.

The new incarnation follows the current restore contract.
A transfer invalidates the authority that it imports.
Every issue with a claim row then needs a new acquisition before its next status write.
The design does not carry claims across the switch, because that needs an exception to the fencing rule.
Memory observations report `stale` with the reason `store_changed`.

Reads can use D1 during step 3 to step 5, because D1 does not change while writes are stopped.

## Release stages build the transition first

The release stages are:

1. **Release 0.4.** Add `src/transition/` with the transition function and its types. Both stores keep their conditional SQL writes, and D1 stays the authority.
2. **Release 0.5.** Add the store Durable Object and the D1 projection. Move authority with the migration from D1 to the store Durable Object. Keep the return path.
3. **After 0.5.** Make outbox delivery and reconciliation stronger and add the measures. Remove the return path only after the failure classes stay at zero for an agreed period.
4. **Later, if a measurement needs it.** Split the store into per-issue authorities, as the next section describes.

### Both stores keep conditional SQL in the first release

`SqlExecutor.batch` takes a fixed list of statements.
It cannot read, decide in code, and then write in one transaction.
Release 0.4 keeps that contract for SQLite and D1.

In release 0.4, both stores call the transition after a rejected write.
The transition classifies the rejection from the observed row, which `update()` does inline today.
The transition is also the specification for the SQL conditions.
A differential test proves that they agree.
It generates states and commands, runs the transition, runs the SQL write on a real database with the same state, and compares the results.

Release 0.5 runs the transition before the write inside `transactionSync`.
The local store can keep conditional SQL, because the differential test keeps it equal to the transition.

## A per-issue split stays gated after 0.5

A per-issue split gives each issue its own Durable Object.
Edits that need no cross-issue answer, such as body, priority, and label edits, comments, and `show`, then scale with the number of issues.
Every other mutation still needs one serialization point for its cross-issue answer.
That covers start, close, reopen, type change, creation, and every claim mutation, because claim request IDs are unique in the store.
The serialization point is a coordinator Durable Object or D1.
Either has the same single-writer limit as the store Durable Object.

In a split, the port and the issue authorities are separate objects, and no transaction covers both.
The port must then keep a mirror of the closed and epic facts of each issue.
Two adversarial reviews of a mirror protocol for this design found defects that let a dependent close while its blocker was active.
The defects came from four mechanisms:

- The order of restrictive and permissive changes between an issue authority and the port.
- The release of claim request ID reservations.
- The routing to per-issue objects named by the incarnation.
- The creation of an issue authority from its creation receipt.

The review proposed these rules for a split.
Nobody has verified them yet:

1. Before the port call, the issue authority writes a durable pending marker with the admitted sequence and a nonce.
2. Each admitted sequence ends as exactly one outbox row, either the commit or an abort row with the full row and the nonce. After a reset, the next request on the object writes the abort row first.
3. The port never clears the floor of a fact. It changes a fact only from a sequenced full row at or above the floor and the stored sequence.
4. When an admission ages out, the port asks the issue authority to resolve its marker. The port never reads and replaces a fact by itself.
5. A claim request ID reservation has the states open with a nonce, bound, and released. An accepted receipt binds the reservation, and bound is final. An abort releases only an open reservation with the same nonce.
6. A rotation stops port admissions for the old incarnation before the copy starts.
7. Migration and reconciliation write the current incarnation into each creation receipt that they create or repair.

Start the split only after both gates pass:

- A measured request rate shows that the store Durable Object cannot serve the store.
- An executable interleaving model of the port protocol passes. With Node built-ins, the model is a `node:test` test that runs random interleavings of admissions, commits, aborts, lost responses, resets, and reordered or repeated signals. It checks after every step that each mirror fact is as strict as the authority or stricter, and that no request ID has two receipts.

The module boundaries below already separate the per-issue write from the cross-issue port, so the split changes where the parts run and leaves their responsibilities unchanged.

## Module boundaries keep the transition pure

The current boundary configuration orders layers as domain, adapter, and entrypoint.
The `records` module is in the domain layer, and it also contains SQL.
A rule that keeps SQL out of the transition therefore needs a new layer below the domain layer.

The proposal adds four modules.
Three hold the transition, the per-issue write, and the cross-issue port of the store Durable Object.
The fourth writes the D1 projection.
Cross-issue search keeps its generated queries in `records`.

| Module | Part | Tags | May import |
| --- | --- | --- | --- |
| `src/transition/` | Transition | `layer:core`, `env:portable` | Nothing outside itself, by the layer order |
| `src/issue-authority/` | Per-issue atomic write in the store Durable Object | `layer:adapter`, `env:worker` | `transition` and the public entry of `cross-issue-port` |
| `src/cross-issue-port/` | Cross-issue port in the store Durable Object | `layer:adapter`, `env:worker` | `transition` |
| `src/projection/` | Writer of the D1 projection | `layer:adapter`, `env:portable` | `transition` |

The local store keeps every part in `src/records/` and `src/local-store/`, because one SQLite file holds them all.
`src/records/` imports `src/transition/` for the decisions.

This change to `archstrict.config.ts` encodes the table:

```diff
     { name: "workspace", glob: "src/workspace/**", surface: "index.ts" },
     { name: "host-hooks", glob: "src/host-hooks/**", surface: "index.ts" },
     { name: "service", glob: "src/service/**", surface: "index.ts" },
+    { name: "transition", glob: "src/transition/**", surface: "index.ts" },
+    { name: "projection", glob: "src/projection/**", surface: "index.ts" },
+    { name: "issue-authority", glob: "src/issue-authority/**", surface: "index.ts" },
+    { name: "cross-issue-port", glob: "src/cross-issue-port/**", surface: "index.ts" },
   ],
   classify: [
     { glob: "src/cli.ts", tags: ["layer:entrypoint", "env:node"] },
     { glob: "src/host-hooks/**", tags: ["capability:host-hooks", "layer:adapter", "env:node"] },
     { glob: "src/service/**", tags: ["capability:service", "layer:adapter", "env:worker"] },
     { glob: "src/service/index.ts", tags: ["capability:service", "layer:entrypoint", "env:worker"] },
+    { glob: "src/transition/**", tags: ["capability:transition", "layer:core", "env:portable"] },
+    { glob: "src/projection/**", tags: ["capability:projection", "layer:adapter", "env:portable"] },
+    { glob: "src/issue-authority/**", tags: ["capability:issue-authority", "layer:adapter", "env:worker"] },
+    { glob: "src/cross-issue-port/**", tags: ["capability:cross-issue-port", "layer:adapter", "env:worker"] },
   ],
   edges: {
     allowDeny: [
       { source: "capability:host-hooks", targetNamespace: "capability", allow: ["host-hooks","records"], because: "host-hooks imports only the capability contracts it uses." },
       { source: "capability:cloud-client", targetNamespace: "capability", allow: ["cloud-client","records","workspace"], because: "cloud-client imports only the capability contracts it uses." },
       { source: "capability:service", targetNamespace: "capability", allow: ["service","records"], because: "service imports only the capability contracts it uses." },
+      { source: "capability:projection", targetNamespace: "capability", allow: ["projection", "transition"], because: "The cross-issue index applies authority signals and cannot reach the write commands of records." },
+      { source: "capability:issue-authority", targetNamespace: "capability", allow: ["issue-authority", "transition", "cross-issue-port"], because: "An issue authority commits one issue and asks the port about other issues; it never reads the search index." },
+      { source: "capability:cross-issue-port", targetNamespace: "capability", allow: ["cross-issue-port", "transition"], because: "The port owns facts that span issues and never writes issue fields or claims." },
     ],
     order: [
       {
         tagNamespace: "layer",
-        sequence: { "": ["domain", "adapter", "entrypoint"] },
+        sequence: { "": ["core", "domain", "adapter", "entrypoint"] },
         direction: "downward-only",
         because: "Domain behavior stays independent of storage, credentials, and transport; adapters implement domain ports; command and Worker entrypoints consume both.",
       },
```

The configuration was checked in a separate worktree with small modules in the four directories.
Each new module imports a type from `src/transition/`, so each new rule evaluates at least one edge.
`archstrict check` reported no violations, and the 25 existing boundary controls in `scripts/check-architecture.ts` passed.
These probes gave the expected results:

| Probe | Result |
| --- | --- |
| `src/transition/` imports `src/records/index.ts` | `tag-order` violation |
| `src/transition/` imports `src/service/index.ts` | `tag-order` violation |
| `src/transition/` imports `node:fs` | `tag-boundary` violation from the portable rule |
| `src/issue-authority/` imports `src/projection/index.ts` | `tag-boundary` violation from the issue authority rule |
| `src/issue-authority/` imports `src/records/index.ts` | `tag-boundary` violation from the issue authority rule |
| `src/issue-authority/` imports a private file in `src/cross-issue-port/` | `public-surface-bypass` violation |
| `src/cross-issue-port/` imports `src/issue-authority/index.ts` | `tag-boundary` violation from the port rule |
| `src/cross-issue-port/` imports `src/projection/index.ts` | `tag-boundary` violation from the port rule |
| `src/projection/` imports `src/records/index.ts` | `tag-boundary` violation from the projection rule |
| `src/projection/` imports `src/issue-authority/index.ts` | `tag-boundary` violation from the projection rule |
| `src/projection/` imports `src/cross-issue-port/index.ts` | `tag-boundary` violation from the projection rule |
| `src/cli.ts` imports a private file in `src/transition/` | `public-surface-bypass` violation |
| `src/records/` imports `src/transition/index.ts` | Allowed |

The configuration has one known gap.
A rule that denies the `solarsql` package to the core layer evaluates no edges while `src/transition/` imports no package.
archstrict reports such a rule as `empty-rule-set`, so the configuration cannot carry it yet.
The order rule still stops the transition from importing `records`, which holds the SQL.
A direct `solarsql` import in `src/transition/` stays possible until archstrict can keep a deny rule for a module with no outgoing edges.

The issue authority rule and the port rule deny `records` in the checked proposal.
In release 0.5, the store Durable Object runs the schema and the queries from `records`.
Add `records` to both allow lists in that change, and keep `projection` out of them.

Add each module and its configuration in the same change.
An empty module glob is an `empty-rule-set` violation, so the configuration cannot come before its module.
Add the new `allowDeny` rules at the end of the list, because the existing controls name earlier rules by index.
Add a boundary control to `scripts/check-architecture.ts` for each probe in the table.
