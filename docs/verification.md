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
