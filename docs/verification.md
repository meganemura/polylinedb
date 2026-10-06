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
