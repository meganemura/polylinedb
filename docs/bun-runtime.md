# Bun runtime findings

polylinedb 0.4.0 does not run under Bun.
Every command exits with `unsupported_runtime`, `--help` included.
A later change lets help and `--version` print on any runtime; every other command still exits with `unsupported_runtime`.
This page records the measurements behind that result, the reason the version checks are correct to refuse Bun, and the experiments that come next.
It records the state on October 8, 2026, adds Linux measurements from October 20, 2026, and declares no Bun support.
polylinedb now adopts solarsql 0.8.0, which refuses Bun by name; [the runtime check since solarsql 0.8.0](#the-runtime-check-since-solarsql-080) describes the current rule.

## Package manager and runtime are separate choices

`npm install` and `bun install` put files into `node_modules`.
Node and Bun execute those files.
A package that npm installed can run under Bun if Bun implements the APIs it calls, so `bun add` is not a requirement for a Bun run.
A switch of package manager alone does not make the CLI run on Bun.

`dist/cli.js` starts with `#!/usr/bin/env node`.
A plain `pd` command therefore starts Node.
A Bun package script also respects the shebang. With Bun 1.4.2, `bun run` on a script with this shebang started Node 26.7.0, and `bun run --bun` started Bun.
To run the CLI under Bun, name the runtime: `bun dist/cli.js COMMAND`.
The CLI error output reports the Node version that the runtime claims, which is the evidence that Bun ran.
Bun 1.4.2 reports Node 26.3.0, and the Node binary in the same test reports 26.7.0, so an implicit fallback to Node shows up as a different version.

## Measured results

Environment: macOS 26.5.2 on arm64, polylinedb 0.3.1 built from source with `npm run build:cli`, and solarsql 0.7.1 from `package-lock.json`.
`npm ci` installed the dependencies. Bun installed nothing.

| Runtime | `process.versions.node` | SQLite from `node:sqlite` |
| --- | --- | --- |
| Node 26.7.0 | 26.7.0 | 3.53.4, the build bundled with Node |
| Bun 1.4.2 | 26.3.0 | 3.51.0, the macOS system library |
| Bun 1.3.14 | 24.3.0 | `node:sqlite` does not resolve |

Each runtime ran the same commands in a fresh temporary `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and Git repository.
No run opened a shared store.

| Command | Node 26.7.0 | Bun 1.4.2 | Bun 1.3.14 |
| --- | --- | --- | --- |
| `--help` | exit 0 | exit 1 | exit 1 |
| `--version` | exit 0 | exit 1 | exit 1 |
| `init` | exit 0 | exit 1 | exit 1 |
| `create` | exit 0 | exit 1 | exit 1 |
| `show` | exit 0 | exit 1 | exit 1 |
| `list` | exit 0 | exit 1 | exit 1 |
| `search` | exit 0 | exit 1 | exit 1 |
| `comment` | exit 0 | exit 1 | exit 1 |
| `context` | exit 0 | exit 1 | exit 1 |

Every Bun failure prints the same error to stderr:

```json
{"error":{"code":"unsupported_runtime","message":"Unsupported Node runtime 26.3.0; required range is ^24.20.0 || >=26.7.0.","details":{"actual_node":"26.3.0","required_node":"^24.20.0 || >=26.7.0","package_version":"0.3.1"}}}
```

Bun 1.3.14 prints the same error with `26.3.0` replaced by `24.3.0`.
Bun created no files in the temporary data directory.

An earlier test on October 3, 2026, used polylinedb 0.0.1 with Bun 1.4.2.
In that test, `--help` and `init` passed, and `create` failed inside the solarsql adapter.
polylinedb 0.3.0 added the bootstrap check that now rejects every command (commit `ab8a126`).

## Why every command fails under Bun

1. `runBootstrap` in `src/cli.ts` compares `process.versions.node` with `engines.node` in `package.json`, which is `^24.20.0 || >=26.7.0`.
   It runs before `cli-commands` loads, so it rejects every command, including `--help`.
   [ADR 0007](adr/0007-cli-runtime-admission.md) records this decision.
   The measurements above stop here.
2. `node()` in solarsql 0.7.1 calls `nodeVersionError` with the same range.
   `openStore` in `src/local-store/index.ts` calls `node()` for every store command.
   `init` uses `DatabaseSync` directly and does not call `node()`, which explains the older result where `init` passed and `create` failed.
   Under polylinedb 0.4.0, Bun still does not reach this check for ordinary commands.
3. The range exists to pin the SQLite build.
   solarsql requires that `node:sqlite` runs the SQLite build that its release tests against in Miniflare.
   The solarsql README records that Node 26.7.0 and workerd both reported SQLite 3.53.4 on September 19, 2026.
   It also records that two SQLite builds with the same major and minor version returned different values for the same expression.

The third point decides the question.
Bun 1.4.2 on macOS runs the system SQLite 3.51.0.
Its `sqlite_source_id()` ends in `aapl` and matches `/usr/bin/sqlite3`.
Node 26.7.0 reports SQLite 3.53.4 with source id `2026-07-24 19:02:57 bf7c7f30…`.
To repeat the comparison, run the same statement under each runtime:

```sh
bun -e 'const { DatabaseSync } = require("node:sqlite"); console.log(new DatabaseSync(":memory:").prepare("select sqlite_source_id() as s").get().s)'
node -e 'const { DatabaseSync } = require("node:sqlite"); console.log(new DatabaseSync(":memory:").prepare("select sqlite_source_id() as s").get().s)'
```

A Bun release that reported Node 26.7 would pass both version checks and still run a different SQLite build.
The version checks are correct to refuse Bun on this machine, and a change that hides the Node version from them would break the D1 parity that they protect.
`bun:sqlite` in Bun 1.4.2 also reports 3.51.0, so a store on `bun:sqlite` has the same mismatch on macOS.

## The node:sqlite APIs work in Bun 1.4.2

A probe script opened a temporary database with `node:sqlite` and called each API that `src/local-store` and `solarsql/node` use.
It did not import `solarsql/node`, so no version check ran.

| API or behavior | Node 26.7.0 | Bun 1.4.2 |
| --- | --- | --- |
| `new DatabaseSync(path)` and `PRAGMA foreign_keys`, `busy_timeout` | pass | pass |
| `SCHEMA_SQL` (schema 6) inside `BEGIN IMMEDIATE` | pass | pass |
| FTS5 virtual table and `MATCH` | pass | pass |
| `setAllowBareNamedParameters(false)` rejects a bare name with `ERR_INVALID_STATE` | pass | pass |
| `all(named, ...positional)` | pass | pass |
| `isTransaction` outside and inside `BEGIN` | pass | pass |
| `SAVEPOINT`, `ROLLBACK TO`, `RELEASE` | pass | pass |
| Constraint error has `code` `ERR_SQLITE_ERROR` and `errcode` 2067 | pass | pass |
| `{ readOnly: true }` rejects a write with `errcode` 8 | pass | pass |

The probe did not test the `RAISE(ABORT)` error with `errcode` 1811 that `retiredConnection` reads.
It also did not run any issue operation, concurrency case, or snapshot round trip.
It did not test the Git child process in `src/workspace/local-config.ts`, which reads the `syscall` and `status` fields of an `execFileSync` error before `init` and `create`.
The probes found no gap in the JavaScript interface. The first blocker that they found is the SQLite build that Bun loads.

## Next experiments

The order follows the dependency between them.

1. Find a way to run Bun with the SQLite build that solarsql tests against.
   Bun 1.4.2 exposes `Database.setCustomSQLite` in `bun:sqlite`.
   Its effect on `node:sqlite` is not measured.
   If a matching library loads, compare `sqlite_source_id()` and run the value probes that solarsql uses for Miniflare, because a version string alone is not enough.
   On Linux x86_64, Bun 1.4.3 already runs that build; see [Linux measurements](#linux-measurements).
   macOS and Linux arm64 on Bun 1.4.3 are not measured.
2. Agree with solarsql on how a runtime proves its SQLite build.
   solarsql 0.8.0 checks the SQLite version itself, and polylinedb's bootstrap follows it.
   It still refuses Bun by name, so a Bun adapter needs a further change in solarsql first.
   solarsql's ADR 0145 names that change: a CI job that runs the node adapter's tests on Bun with SQLite 3.53.4 or later, and a new ADR that admits a range of Bun releases.
   The Linux measurements show that such a job can run on Bun 1.4.3.
   A version string is weaker evidence than `sqlite_source_id()` and the value probes in step 1.
3. Compare a store on `bun:sqlite` only after step 1 gives a matching SQLite build.
   Keep issue operations, ID allocation, field-version conflicts, and the snapshot format shared, and keep runtime differences inside the database boundary.
4. Measure `bun build --compile` and `--bytecode` only after the CLI runs under Bun.
   That output bundles the Bun runtime. It is a different distribution format from an ahead-of-time compiled Go binary.
   Compare start time, binary size, the per-OS and per-CPU builds, and the update procedure.
5. Measure the Node CLI.
   Separate the Git child process, module loading, database open, SQL, and JSON output, and improve the part that dominates.

This page has no start-time table.
Under Bun, only the rejection path runs, so a time would measure the bootstrap check and nothing else.

The install and run combinations remain unmeasured: `bun install` with a Node run, and `bun install` with a Bun run.
`bun install` writes `bun.lock`, so run it in a disposable copy of the repository.

## Help and version after this measurement

In 0.4.0, `--help` and `--version` print on an unsupported runtime without loading storage modules. Every other command still exits with `unsupported_runtime`.
The bootstrap now answers help and `--version` before the check, because neither loads solarsql or opens a store.
[ADR 0007](adr/0007-cli-runtime-admission.md) lists the forms that bypass the check.
The measured tables above record 0.3.1 and stay unchanged.

## The runtime check since solarsql 0.8.0

polylinedb adopts solarsql 0.8.0.
Its `node()` adapter reads the SQLite version that `node:sqlite` runs and refuses a version older than 3.53.4, the SQLite of the workerd that its release tests against.
It refuses Bun and Deno by name before it reads the Node version, and it still requires Node `^24.20.0 || >=26.7.0`.
The refusal is `UnsupportedRuntimeError` from `solarsql/node`, with the code `UNSUPPORTED_RUNTIME`.

The polylinedb bootstrap in `src/cli.ts` applies the same rule in the same order before any command module loads, so `init` and cloud commands are covered too:

1. A process that sets `process.versions.bun` or `process.versions.deno` gets `unsupported_runtime` with a message that names the runtime, the Node version it reports, and its SQLite version.
2. A Node version outside the manifest range gets the same message as before.
3. A Node in range whose `node:sqlite` runs a SQLite older than 3.53.4, or reports no version, gets `unsupported_runtime` with the SQLite version in the message.

Every refusal carries `details` with `actual_node`, `required_node`, `package_version`, `runtime`, `runtime_version`, and `required_sqlite`. The name and SQLite refusals add `actual_sqlite`.
Bun 1.4.2 on macOS, measured above, now gets this message instead of the Node version message:

```json
{"error":{"code":"unsupported_runtime","message":"Unsupported runtime Bun 1.4.2, which reports Node 26.3.0 and whose node:sqlite runs SQLite 3.51.0. polylinedb requires Node ^24.20.0 || >=26.7.0 with node:sqlite on SQLite 3.53.4 or later. Run pd with Node.","details":{"actual_node":"26.3.0","required_node":"^24.20.0 || >=26.7.0","package_version":"0.5.2","runtime":"bun","runtime_version":"1.4.2","actual_sqlite":"3.51.0","required_sqlite":"3.53.4"}}}
```

This output comes from a simulated Bun in the test suite, not from a Bun run; Bun was not rerun for this change.
A Bun release that reports Node 26.7 and links SQLite 3.53.4 is still refused, because solarsql refuses Bun by name.
A caller that opens a store through `openStore` without the bootstrap gets the solarsql refusal as `unsupported_runtime` with `details.solarsql_code` set to `UNSUPPORTED_RUNTIME`, instead of `internal_error`.

## Linux measurements

Environment: Ubuntu 24.04.5 on x86_64, measured on October 20, 2026.
Bun 1.4.2 came from the machine's install. Bun 1.4.3 came from the `@oven/bun-linux-x64@1.4.3` npm package, released on October 10, 2026.
Node 24.20.0 came from the official Linux x64 tarball.
The system library is SQLite 3.45.1, and no runtime below loads it.

| Runtime | `process.versions.node` | SQLite from `node:sqlite` | `sqlite_source_id()` |
| --- | --- | --- | --- |
| Node 24.20.0 | 24.20.0 | 3.53.4 | `2026-07-24 19:02:57 bf7c7f30…` |
| Bun 1.4.3 | 26.3.0 | 3.53.4 | `2026-07-24 19:02:57 bf7c7f30…` |
| Bun 1.4.2 | 26.3.0 | 3.53.2 | `2026-06-03 19:12:13 d6e03d8c…` |

The Bun binary links only libc, libpthread, libdl, and libm, so its SQLite is compiled in.
`bun:sqlite` reports the same version and source id as `node:sqlite` in each Bun release.
Bun 1.4.3 and Node 24.20.0 report the full 64-character source id with the same value.

solarsql's runtime contract probe, `spike/16-runtime-contract.ts` in the solarsql repository, prints the answers that ADR 0145 compares.
Run from a solarsql checkout after `npm ci`, it gave the same answer on Bun 1.4.3 and Node 24.20.0 for every probe:
text with an embedded NUL, an integer beyond the safe range, a named parameter followed by a positional one, a savepoint rollback, REAL text through `json_array(0.1 + 0.2)`, the error codes of a constraint failure (1555) and of a trigger's `RAISE(ABORT)` (1811), and the plan and full-scan report of an `EXISTS` query.
Bun 1.4.2 on Linux gave the same answers as well, except for its SQLite version.
This differs from Bun 1.4.2 on macOS, whose system SQLite 3.51.0 changed the REAL text and the full-scan report.

```sh
node spike/16-runtime-contract.ts
bun spike/16-runtime-contract.ts
```

The pd 0.5.2 CLI, built from this repository, still refuses Bun 1.4.3 by name, as the rule since solarsql 0.8.0 requires.
This is a real Bun run, not the simulated one in the test suite:

```json
{"error":{"code":"unsupported_runtime","message":"Unsupported runtime Bun 1.4.3, which reports Node 26.3.0 and whose node:sqlite runs SQLite 3.53.4. polylinedb requires Node ^24.20.0 || >=26.7.0 with node:sqlite on SQLite 3.53.4 or later. Run pd with Node.","details":{"actual_node":"26.3.0","required_node":"^24.20.0 || >=26.7.0","package_version":"0.5.2","runtime":"bun","runtime_version":"1.4.3","actual_sqlite":"3.53.4","required_sqlite":"3.53.4"}}}
```

On Linux x86_64, the SQLite build no longer separates Bun 1.4.3 from Node.
The refusal by name is now the only rule that refuses it.
These probes do not cover the polylinedb store: no issue operation, concurrency case, snapshot round trip, or Git child process ran on Bun.

## Non-goals

- Shipping a Bun adapter or a Bun entry point in this work.
- Weakening the Node or D1 contracts, the data format, or the durability rules to fit Bun.
- Faking `process.versions.node` or disabling a version check to make a command pass.
- Adding a custom adapter only to avoid a version check.
- Comparing Go and JavaScript in general. Any comparison with another tool uses separate synthetic data and matched query, result size, persistence, and connection conditions.

## References

The Bun links were checked on October 3, 2026.

- [Bun runtime and shebang handling](https://bun.sh/docs/runtime)
- [Bun package manager](https://bun.sh/docs/pm/cli/install)
- [Bun Node.js compatibility, including node:sqlite](https://bun.sh/docs/runtime/nodejs-compat)
- [bun:sqlite](https://bun.sh/docs/runtime/sqlite)
- [Bun single-file executables](https://bun.sh/docs/bundler/executables)
- [Dependencies](dependencies.md) records the solarsql version, its Node range, and its SQLite floor.
