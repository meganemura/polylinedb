# Verify behavior and architecture

Install the pinned development dependencies with `npm ci --ignore-scripts`.
Run these checks before committing a behavior or boundary change:

```sh
npm run typecheck
npm run check:architecture
npm test
npm run check:ui-latency
npm run test:d1
npm run test:worker
npm run test:package
```

The D1, Worker, and authentication fixtures need temporary local listeners.
Tests use synthetic data. They do not validate a deployed account or a host's lifecycle events.
The package check installs the tarball into a temporary prefix and executes its CLI.

## CI runtime and operating systems

CI runs every required check on Ubuntu 24.04 and Ubuntu 26.04 with Node 24.22.1 and Node 26.12.1.
The four jobs verify generated SQL, types, architecture boundaries, unit tests, the `/ui` latency budget, D1, the Worker, and the installed package.
Explicit operating-system labels keep the verification conditions stable when GitHub changes `ubuntu-latest`.

The workflow pins `actions/checkout` v7.0.1 and `actions/setup-node` v7.0.0 to full commit SHAs.
Both actions declare the Node 24 runtime.
The repository permits selected actions and requires full SHA pins.

GitHub announced the `ubuntu-latest` migration for October 19 through November 19, 2026.
See the [Ubuntu 26 announcement](https://github.blog/changelog/2026-09-17-ubuntu-26-generally-available-and-latest-migration/).
See the official releases for [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) and [setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0).

The CI fixtures use synthetic OAuth responses and credentials.
Real credential-store access and host authentication require separate verification on the target system.

## Generated behavior tests

```sh
npm run test:properties
PD_HEGEL_CASES=1000 npm run test:properties
```

Hegel uses fixed seeds and 100 cases per property by default.
The properties cover numeric ID ordering and uniqueness, independent field versions, stale writes, creation retries, and snapshot round trips.
They also reject duplicate snapshot IDs and unsupported snapshot versions.
The operation sequences run against real SQLite stores.
The port protocol property runs against a model of a split store, which [Interleaving model](#interleaving-model) describes.
The D1 fixtures check the shared behavior separately with workerd.
Lease properties use 30 generated TTL pairs against real SQLite and verify immutable acquisition replay after renewal.
The D1 suite also checks concurrent claim admission, status fencing, receipt replay, rollback, and incarnation changes.
Generated properties have not been run against a deployed D1 store.

Hegel stores minimized failures in the ignored `.hegel` directory.
Keep a reproducible failure as a behavior test before changing its implementation.
A deliberate inversion of the ordering property verified failure reporting and shrinking.

## Specification properties

```sh
node --test test/spec-properties.test.ts
```

The differential test compares the transition with SQL that shares its reading of the rules, so it cannot find a mistake that both make.
These properties come from sentences in `docs/claims.md`, `docs/prerequisites.md`, `docs/architecture.md`, `docs/adr/0009-issue-ownership.md`, and `CONTEXT.md`.
Each property cites its sentence, and its expected value comes from that sentence rather than from a transition call.

The exhaustive test enumerates a bounded domain instead of sampling it.
The domain covers never-claimed, held, released, and invalidated leases, and a clock before, equal to, and after the deadline.
A proof is missing or differs in any subset of issue, incarnation, session, and generation, and the caller is the holder or another actor.
Renewal and release name their issue only through the proof, so their domain omits a proof for another issue.
Issue updates also vary the requested field, active blockers, children, and the force option.
The October 10, 2026 run checked 20796 combinations: 12 claim states, 19584 issue updates, 816 claim mutations, and 384 agent gate decisions.
The readiness property creates 240 dependents in SQLite with every status, every set of up to two blocker statuses, and four label sets.
It compares the ready, agent ready, and blocked worklists with the documented definitions.

The Hegel generators now produce the boundary values.
The TTL property draws the minimum and the maximum TTL explicitly and checks that both appear.
Before this change, 4 of 20 unseeded runs drew the maximum TTL.
The differential adds a lease whose deadline equals the clock at seeding.
A 100-case run checks that empty blocker sets, empty label sets, and a clock equal to the deadline each appear.
Before this change, the differential never generated a clock equal to the deadline.

A deliberate defect in `claimState` treated a deadline equal to the clock as active, and three properties failed:

- `property: every bounded claim, proof, and clock combination follows the documented rules` reported `{"lease":"held","clock":"equal"}` as `'active'` where `'expired'` was expected.
- `property: a proof whose deadline equals the clock cannot change the status` reported an accepted status write by the holder with a matching proof.
- `property: only the holder of the current proof changes the status of a claimed issue` reported the same accepted write.

With the earlier differential fixture, the differential test passed with the same defect.
With the deadline lease, it fails, because SQLite treats that lease as expired and the transition treats it as active.
The defect was reverted and is not part of the repository.

## Bounded mutation tests

```sh
PD_HEGEL_CASES=20 npm run test:mutation
```

The configuration mutates selected ID, update, create, and snapshot-version logic.
It runs the existing issue and snapshot tests, including their properties, with two workers and a ten-second mutant timeout.
The agent reporter writes ignored results under `reports/mutation/`.
Read its surviving mutants and add tests for missing observable behavior.
Run the affected scope again after each test change.

The initial run had 21 survivors and 18 mutants without coverage.
Tests added checks for missing issues and parents, returned updates, and retaining an epic with children.
The final bounded run measured 111 mutants in 52 seconds.
It killed 107 mutants and left four survivors, with no missing coverage, timeouts, or execution errors.
The four survivors replace English error messages while preserving structured error codes and state.
Exact message text is outside this check's contract. These survivors are presentation changes, not proven equivalent mutants.
The result covers the selected ranges, not the entire application.

One sorting mutant exposed an unbounded loop in the pagination test.
The test now rejects repeated IDs immediately and limits pages to the known fixture size.
The same mutant then failed the test in two seconds, within the original timeout.

Stryker 10.0.0 calls TypeScript's `parseConfigFileTextToJson` function.
TypeScript 7.0.2 does not expose this function.
The configuration excludes both TypeScript configuration files from Stryker's temporary sandbox.
Node executes these TypeScript tests directly, so that exclusion does not change the test command.
Keep the normal type check as a separate required check.

## Transition mutation

```sh
PD_HEGEL_CASES=20 npm run test:mutation
```

Stryker 10.0.0 mutates `src/transition/**/*.ts` together with the existing ranges in `src/records/store/issue-id.ts`, `src/records/issues/issues.ts`, `src/records/store/issue-record.ts`, and `src/records/persistence/snapshot.ts`.
The run uses the issue, snapshot, transition, claim, differential, and agent-gate tests, two workers, and a ten-second mutant timeout.
`PD_HEGEL_CASES=20` bounds the generated cases.
The machine has 4 vCPUs.
The runtime is Node 24.21.0.

Stryker treats a TypeScript `as const` expression as a type node and does not walk it.
`src/transition/vocabulary.ts`, `actorKinds`, and `src/transition/index.ts` therefore contribute no mutants.
`MAX_COUNTER` is a property read with no operator to replace.
The issue-id range is lines 16–20, which are now a return and a binding, so that range contributes no mutants either.
The issues and snapshot ranges are the same text as the earlier bounded run.
Those files have grown, so the ranges now cover the update rejection path and the snapshot comparators.

The run before the tests in this section measured 435 mutants in 6 minutes 51 seconds.
It killed 380, left 37 survivors, timed out 2, and found 16 with no coverage.
`src/transition` held 296 of them: 293 killed and 3 survivors, with no timeouts and no missing coverage.
`src/records/issues/issues.ts` held 119: 82 killed, 2 timeouts, 29 survivors, and 6 with no coverage.
`src/records/persistence/snapshot.ts` held 20: 5 killed, 5 survivors, and 10 with no coverage.

The added tests check which edits honor active prerequisites, including a close paired with another field.
They check that an exhausted status stays `version_exhausted` when the issue has no blocker and when force is set on a blocked issue.
They check that a skipped update the transition would accept, and an update after the store identity row is gone, are `storage_error`.
They check that `not_found`, `version_exhausted`, `epic_has_children`, and `dependency_blocked` name the issue, and that version exhaustion names the field.
They check that a snapshot orders comments by id.

The run after those tests measured the same 435 mutants in 4 minutes 54 seconds.
It killed 407, left 26 survivors, and found 2 with no coverage.
There were no timeouts and no execution errors.
The transition counts did not change: 293 killed and 3 survivors.
`issues.ts` then had 104 killed, 13 survivors, and 2 with no coverage.
`snapshot.ts` had 10 killed and 10 survivors.

### Survivors that do not change a result

Three survivors in `holdsClaim` replace `claim !== null`, `proof.incarnation === storeIncarnation`, or `claim.incarnation === proof.incarnation` with `true`.
An active `claimState` already requires a claim whose incarnation equals the store.
With the other incarnation comparison still present, each removed check follows from the rest.
A null claim still fails the active-state check before the function reads claim fields.

Replacing `has_children === 1` with `true` does not change an update result.
The SQL write already rejects a non-epic type when children exist.
`decideIssueUpdate` reports a version conflict, an ownership failure, an active prerequisite, or version exhaustion before it reads that flag.
When the epic check can reject, the observed flag is already 1.

Replacing `proof === undefined` with `false` always copies `claim_proof`.
A missing proof is `undefined`, and ownership treats that value as no proof.

Replacing `typeof ownershipRow.store_incarnation !== 'string'` or `typeof ownershipRow.observed_at !== 'number'` with `false` does not change a result.
A missing identity row is already rejected.
When the row exists, the observation query returns a text incarnation and `unixepoch()` as an integer.

Replacing `'issue_write'` with an empty string does not change admission.
`admitAgentWrite` distinguishes `claim_acquire` from every other write kind.

Ten survivors in `compareId` and `compareText` replace the greater-than test, or turn a less-than into a less-than-or-equal.
On Node 24.21.0, `Array.prototype.sort` orders the distinct keys of an accepted snapshot the same way after those replacements.
Duplicate ids are rejected, so an equality result is not part of an accepted snapshot.

Eight survivors replace an English message with an empty string and leave the error code and details in place.
The messages are: issue not found, a missing claim observation, an update the database did not apply, a stale read, a missing ownership proof, active prerequisites, version exhaustion, and an epic with children.
Exact message text is outside this check's contract.
These survivors are presentation changes, not proven equivalent mutants.

### Unreachable rejection default

Two mutants have no coverage.
They delete the `default` arm of the update rejection switch.
`UpdateRejection` has no other member, so that arm does not run.
Deleting it does not change behavior.

## Defect injections

A check that passes is evidence only when it fails on the defect it targets.
Each existing check keeps its injected defects as a test, so a change that weakens the check fails CI.
The injections wrap the store executor. The production writer stays unchanged.

| Check | Injected defect | Test that keeps the injection | Status |
| --- | --- | --- | --- |
| Change feed contract | The store deletes the first committed event | `test/change-feed-defects.test.ts` (SQLite), `test/changes-d1.integration.ts` (D1) | Fails as expected |
| Change feed contract | The store records an event for a rejected `request_conflict` create | `test/change-feed-defects.test.ts` (SQLite), `test/changes-d1.integration.ts` (D1) | Fails as expected |
| Interleaving model | A restrictive change commits at its issue authority before the port admits it | `test/port-protocol.test.ts` | Fails as expected |
| Interleaving model | An abort row releases a claim request ID reservation in any state | `test/port-protocol.test.ts` | Fails as expected |
| Interleaving model | A rotated port still admits what a stale Worker instance routes to it | `test/port-protocol.test.ts` | Fails as expected |
| Interleaving model | An empty object builds its issue authority from a creation receipt that names another incarnation | `test/port-protocol.test.ts` | Fails as expected |
| Interleaving model | A blocker reopens or joins open while a dependent holds the answer that its blockers are closed | `test/port-protocol.test.ts` | Fails as expected |
| Cold reconciliation | A projection that still shows a released claim | None | Pending: reconciliation does not exist |

No check has found a defect that stays unfixed, so CI pins no expected failure.
When a check finds one, pin the failure in CI, so the fix makes CI report the stale pin.

### Change feed contract

```sh
node --test test/change-feed-defects.test.ts
node --import ./scripts/test-node-runtime.mjs test/changes-d1.integration.ts
```

The contract is `runChangeFeedFlow` in `test/fixtures/change-feed-flow.ts`.
`test/changes.test.ts` runs it on an unmodified local SQLite store, and `test/changes-d1.integration.ts` runs it on an unmodified workerd D1 database.
`test/fixtures/change-feed-defects.ts` wraps a real store executor with one defect and calls `runChangeFeedFlow`.
The injection passes only when the contract fails an assertion with the expected message.
The SQLite test and the D1 integration run the same injections, each on a fresh database.

On 2026-10-15, Node 24.22.0 reported both failures on local SQLite and on workerd D1.

A store that deletes the newest `change_events` row after the first committed event makes the contract expect the `created` event for `cf-1` at `seq` 1 and observe no events.
The assertion text is `Expected values to be strictly deep-equal`, with actual `[]` and expected `issue_id: 'cf-1'`, `kind: 'created'`, `seq: 1`.

A store that inserts one `change_events` row after the `request_conflict` create makes the contract report `rejected request_conflict recorded no event` with `4 !== 3`.
The three earlier creates left `seq` 3.
The rejected write left `seq` 4.
That injection waits for the contract's second mutation that records nothing.
The first is the create replay.
The second is the `request_conflict` create.

The same run with the injection removed failed both SQLite tests and the D1 integration with `Missing expected rejection`.
The injection tests therefore depend on the defect, not on an unrelated failure.

### Interleaving model

```sh
node --import ./scripts/test-node-runtime.mjs --test test/port-protocol.test.ts
PD_HEGEL_CASES=10000 node --import ./scripts/test-node-runtime.mjs --test --test-name-pattern='^property:' test/port-protocol.test.ts
```

`docs/issue-authority.md` requires this model before a per-issue or per-project split.
`test/fixtures/port-protocol.ts` models a split store.
It has one issue authority for each issue and incarnation, one port for each incarnation, and the network between them.
It imports nothing from `src/`, because the split does not exist.
Each Hegel case starts from one seed world and runs 60 steps.
In the seed world, `i1` is a closed task that holds claim request ID `c1`.
`i2` and `i3` depend on `i1`, and `i3` is an epic.
The init of `i2` was lost, so its first touch makes its issue authority.

Each step does one of these actions:

- A client request through the current routing, or through a Worker instance that still routes by the previous incarnation.
- The delivery, repetition, or loss of a message.
- The delivery of an outbox row, with or without its acknowledgement.
- A timeout of the handler that waits for an answer.
- A reset that loses the handler and keeps the durable state.
- An age-out of an open admission.
- A creation, with or without its init.
- A new dependency edge.
- A rotation of the port, the end of stale routing, or a first touch by a background sweep.

The admission request and the answer of the port are messages.
The network can lose, repeat, or delay each message, so an admission can reach the port after its own abort row.
An outbox row stays in the outbox until the port acknowledges it.
The network can repeat or delay a row, but it cannot lose a row.

A schedule uses two bytes for each step.
The first byte selects the action kind by weight, and the second byte selects one enabled action of that kind.
A kind with no enabled action does nothing, so a byte selects the same kind in every world.
Then shrinking can remove a step and keep the kinds of the steps after it.

`test/fixtures/port-protocol-check.ts` reads the world after each step and checks three invariants:

- Safety A: each fact that the current port relies on is true at the issue authority of record.
  The port relies on a closed fact in its mirror and on an epic fact in its mirror or in a child.
  It also relies on the blockers of each dependent whose close it admitted and whose row it has not applied.
- Safety B: no claim request ID or creation request ID has two receipts in any incarnation.
- Close witness: when a close commits, each blocker of the closing issue is closed at its issue authority of record.

The issue authority of record is the newest object for the issue that is not retired.
The property also requires each event in `mustReach` at least once.
It requires that no age-out finds a sequence that its authority did not admit.
Each injection replaces one rule in `protocolRules`.
An injection passes only when the report names the expected invariant and a trace step that shows the mechanism.
Each test keeps its stored examples in its own directory under the ignored `.hegel/port-protocol/` directory.

The model needs these readings in addition to the seven proposed rules:

- The pin: an open close admission holds the answer that the blockers of the dependent are closed.
  While the admission is open, the port refuses a reopen of a blocker and an edge to a blocker that is not closed.
  The fifth injection removes the pin.
- One marker for each issue authority: the authority refuses a request while a handler waits for an answer.
  Rule 2 and the floors of rule 3 assume that sequences end in order.
- A commit needs its marker: a sequence commits only while its marker stands.
  An age-out or a pull that ended the marker wins over a late answer.
- A pull ends the open marker of the source as an abort row, copies the durable state, and retires the source.
  A source that was not made becomes a retired tombstone, so a late init cannot make the issue in the old incarnation.
- Rule 7: a creation receipt names the incarnation that holds the issue authority.
  Creation and a pull write that incarnation.
  An empty object builds its issue authority from the receipt only when the receipt names its own incarnation.
  Otherwise, the object pulls the issue authority from the named incarnation.

The literal reading of rule 7 fails.
In that reading, the port copy writes the new incarnation into each receipt that it copies.
Then a first touch builds the closed `i1` from its creation receipt, which says open.
A scratch copy of the model with that reading reported Safety A after two steps: a rotation, then a request for `i1`.

Safety A and the close witness both catch a missing pin.
Safety A fires first, because the answer reliance starts at the admission and the close commits before its row ends the admission.
The fifth injection therefore matches the Safety A message for the answer reliance.
A rotated port that admits can fail each of the three invariants, so the third injection matches only the trace step `by a rotated port`.

On 2026-10-19, Node 24.20.0 on a machine with 4 vCPUs measured these results at seed 20261019.
The whole file took 1.35 to 1.46 seconds in three runs with no stored examples.
The property took 131 to 173 milliseconds at 100 cases.
It took 0.73 seconds at 1,000 cases and 5.9 seconds at 10,000 cases.
At 100 cases, the least frequent `mustReach` events were `refused-children` (3), `refused-pinned` (9), and `row-below-floor` (17).
At 10,000 cases, the same events occurred 481, 889, and 1,201 times.

A throwaway loop ran each injection at seeds 1 to 20 with 100 cases and no stored examples.
Each injection failed at all 20 seeds.
A trace step count excludes the steps that do nothing.

| Injection | Cases to first failure, median (maximum) | Shrunk trace steps, median (range) | Seed 20261019: cases, steps |
| --- | --- | --- | --- |
| Restrictive change at the authority first | 3 (11) | 3 (3 to 3) | 3, 3 |
| Abort releases any reservation | 15 (56) | 9 (7 to 16) | 37, 14 |
| Rotated port admits | 11 (41) | 4 (4 to 17) | 8, 3 |
| Receipt from another incarnation | 3 (6) | 2 (2 to 2) | 2, 2 |
| Pin removed | 13 (57) | 6 (3 to 11) | 2, 3 |

The shortest possible traces are 3, 6, 3, 2, and 3 steps.
Over the 20 seeds, the rotated port injection failed 17 times through Safety A, 2 times through Safety B, and once through the close witness.
The model checks the protocol under its abstractions only.
It does not run a Durable Object, D1, or a real network.

### Cold reconciliation

`docs/issue-authority.md` describes a comparison of the store Durable Object with the D1 projection.
The repository has no projection and no reconciliation run.
When reconciliation exists, inject a projection that still shows a released claim.
The run must count it as a missed revocation and repair it.
