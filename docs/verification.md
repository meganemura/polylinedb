# Verify behavior and architecture

Install the pinned development dependencies with `npm ci --ignore-scripts`.
Run these checks before committing a behavior or boundary change:

```sh
npm run typecheck
npm run check:architecture
npm test
npm run test:d1
npm run test:worker
npm run test:package
```

The D1, Worker, and authentication fixtures need temporary local listeners.
Tests use synthetic data. They do not validate a deployed account or a host's lifecycle events.
The package check installs the tarball into a temporary prefix and executes its CLI.

## CI runtime and operating systems

CI runs every required check on Ubuntu 24.04 and Ubuntu 26.04 with Node 24.20.0 and Node 26.7.0.
The four jobs verify generated SQL, types, architecture boundaries, unit tests, D1, the Worker, and the installed package.
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
The D1 fixtures check the shared behavior separately with workerd.
Lease properties use 30 generated TTL pairs against real SQLite and verify immutable acquisition replay after renewal.
The D1 suite also checks concurrent claim admission, status fencing, receipt replay, rollback, and incarnation changes.
Generated properties have not been run against a deployed D1 store.

Hegel stores minimized failures in the ignored `.hegel` directory.
Keep a reproducible failure as a behavior test before changing its implementation.
A deliberate inversion of the ordering property verified failure reporting and shrinking.

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

Stryker 10.0.0 mutates `src/transition/**/*.ts` together with the existing ranges in `src/records/issue-id.ts`, `src/records/issues.ts`, and `src/records/snapshot.ts`.
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
`src/records/issues.ts` held 119: 82 killed, 2 timeouts, 29 survivors, and 6 with no coverage.
`src/records/snapshot.ts` held 20: 5 killed, 5 survivors, and 10 with no coverage.

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
