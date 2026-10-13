# Measure local Git lookup cost

A local command asks Git which repository contains the working directory.
This page records the datasets, the command shape, and the limit of that measurement.

## Datasets

The commands run against synthetic files in a temporary directory.

- A Git repository created with `git init --quiet --initial-branch=main` and no commits.
- One named local connection. Its data directory is an empty directory outside that repository, mode `0700`, initialized with `pd init --connection NAME --tool demo --project demo --actor local:owner --prefix pd`.
- One issue in that store, created before a repeated `list`.
- The same `list` with the working directory set to a directory that is not a Git repository. That run caches the answer that there is no repository.

No cloud connection, deployed Worker, or production store is in these datasets.

## Count Git starts

Place a `git` executable ahead of the real Git on `PATH`.
The stand-in records each argument list and then executes the real Git.
Run the CLI from the repository the way a user does:

```sh
pd --connection NAME create --tool demo --project demo --body 'Synthetic issue' --actor local:owner
pd --connection NAME list --actor local:owner
```

Each command is a new process.
Without the cache, `create` and `list` each start Git four times.
The four argument lists are identical: `-C DIRECTORY rev-parse --is-inside-work-tree --show-toplevel --git-common-dir`.
With the cache, each command starts Git once.
`test/local-config.test.ts` counts those starts.

## Child process time

`/usr/bin/time -f '%U %S'` prints the child user time and the child system time.
Those times include Git children. They are not wall-clock latency.

```sh
/usr/bin/time -f '%U %S' pd --connection NAME list --actor local:owner
```

Repeat the command and state the sample count.
One local sample ran `list` 20 times on Node 24.21.0 against the synthetic store above, before the cache and again after it.
The median of child user time plus system time was 0.29 s before and 0.25 s after.
The before samples spanned 0.27 s to 0.32 s, and the after samples spanned 0.23 s to 0.28 s.
The two spans meet, so this sample does not establish a CPU budget.
The same runs had median elapsed times of 0.17 s before and 0.14 s after.
Elapsed time is wall-clock time, and this page does not treat that delta as a product claim.
The spawn count is the evidence for the cache.

## Command workloads

`list`, `search`, `create`, `comment`, `update`, and `export` ran against two synthetic stores. Each command is a new Node process. The working directory is a Git repository with stealth repository defaults, so the command passes neither `--connection` nor `--data-dir`.

The small store has 100 issues, 50 comments, and 20 memories. The large store has 2,500 issues, 100 comments, and 20 memories. Every issue body, comment body, and memory body contains `benchneedle`. `list --limit 50 --project bench` and `search benchneedle --limit 50` each return 50 issues, and a search excerpt contains `benchneedle`. `export` returns every issue, comment, and memory. A write sample copies the store from a pristine snapshot, then runs one `create`, `comment`, or `update`.

Commit `90af9d7` starts Git three times for `list` and for `create`. Commit `7700fb3` starts Git once. The argument list is `rev-parse --is-inside-work-tree --show-toplevel --git-common-dir` every time. Commit `81851b6` adds the cache, and `local-config.ts` does not change again through `7700fb3`.

The run used Node 24.21.0 on a 4-core machine whose one-minute load average stayed under 1.4. Each build had one unrecorded warmup and then five rounds. The build order alternated. Every recorded command exited 0. List and search returned 50 issues, a search excerpt contained `benchneedle`, and export returned the full counts.

Wall-clock times are milliseconds.

| command | store | before median | before min | before max | after median | after min | after max |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| list | small | 57.2 | 54.4 | 60.0 | 55.3 | 54.5 | 67.1 |
| search | small | 60.6 | 58.4 | 61.9 | 59.9 | 59.6 | 66.7 |
| create | small | 62.3 | 61.1 | 66.8 | 62.4 | 58.4 | 71.4 |
| comment | small | 64.8 | 62.2 | 67.4 | 63.6 | 60.2 | 67.7 |
| update | small | 64.3 | 61.6 | 65.8 | 63.2 | 58.4 | 68.2 |
| export | small | 63.7 | 62.1 | 65.9 | 60.3 | 59.8 | 71.4 |
| list | large | 58.7 | 56.4 | 60.3 | 57.1 | 53.6 | 62.1 |
| search | large | 61.5 | 57.7 | 63.1 | 59.7 | 58.3 | 70.3 |
| create | large | 70.8 | 64.0 | 72.4 | 65.2 | 61.1 | 72.0 |
| comment | large | 68.4 | 64.8 | 69.4 | 64.5 | 58.9 | 68.3 |
| update | large | 66.0 | 62.5 | 71.3 | 64.1 | 63.6 | 66.7 |
| export | large | 153.5 | 151.1 | 155.5 | 153.3 | 146.8 | 181.0 |

The minimum-to-maximum span of the two builds overlaps on every row. This run does not establish a wall-clock speedup.

`node -e 0` had medians of 17.5 ms next to the before rounds and 16.6 ms next to the after rounds. `pd --version` had medians of 21.8 ms and 22.2 ms.

Four concurrent searches all succeeded. The batch wall medians were 73.7 ms before and 80.1 ms after on the small store, and 76.8 ms and 71.8 ms on the large store. Four concurrent creates all succeeded. The batch wall medians were 104.2 ms and 104.4 ms on the small store, and 99.0 ms and 93.0 ms on the large store.

finderscope 0.3.0 profiled one run of each command with `finderscope run -- node dist/cli.js ...`. Those runs are not in the table. On `list`, `search`, `create`, `comment`, and `update`, the largest cost is the dynamic import in `runBootstrap`, about 21 to 28 ms of a profile totaling about 46 to 61 ms. `finderscope top --by self` names `compileSourceTextModule` first. Git `execFileSync` is about 4 to 8 ms before the cache and about 2 to 3 ms after it, in these single profiles. The sampling interval is Node's default of 1 ms, so each of those figures is one run. A large `export` profile totals 157 ms before and 143 ms after. Its largest costs are text encoding, the same import, writing JSON to stdout, and reading snapshot rows.

A fresh process that imports `dist/cli-commands.js` spends about 25 ms in that import. Importing `dist/local-store/index.js` alone spends about 24 ms. The command graph and the store graph cost about the same, so removing an unused import does not remove startup. The cloud client is already a separate dynamic import and is not part of that 25 ms.

## Local baseline on an Apple M4 host

This run measures the local CLI at commit `def7a9c` (package 0.5.2). It uses a different host and Node version from the table above, so do not compare the two tables row by row.

### Host

- Apple M4, 10 cores, 32 GB memory, macOS 26.5.2.
- Node 26.7.0.
- The one-minute load average was between 2.0 and 2.9 before and after each run.
- Other applications stayed open: the Claude desktop app, WindowServer, Photos, and Activity Monitor. No heavy build or test process ran.

### Datasets and procedure

The datasets copy the earlier workloads. The small store has 100 issues, 50 comments, and 20 memories. The large store has 2,500 issues, 100 comments, and 20 memories. Every body contains `benchneedle`.

1. Point `XDG_CONFIG_HOME` and `XDG_DATA_HOME` at empty temporary directories. This keeps the user's connections and stores out of the run.
2. Create an empty Git repository. Add a local connection whose data directory is outside the repository, with mode `0700`.
3. Run `pd init --stealth --connection NAME --tool demo --project bench --actor local:owner --prefix pd`.
4. Seed each store with `create`, `comment`, and `memory create`. Keep a copy of each seeded store.
5. Before each sample, replace the data directory with a copy of the seeded store, and run `pd context` to check that the store is under the temporary directory. Both steps are outside the timed region. `pd context` also starts Git, so in the `/usr/bin/git` variant every timed command follows a shim run.
6. Start each command as a new process with `spawnSync(process.execPath, ['dist/cli.js', ...args])`. Time it with `process.hrtime.bigint()`. Check exit status 0 and the expected result.

The commands are:

```sh
pd list --limit 50 --project bench
pd search benchneedle --limit 50
pd show pd-1
pd create --tool demo --project bench --body 'Bench create benchneedle'
pd comment pd-1 --body 'Bench comment benchneedle'
pd update pd-1 --body 'Bench update benchneedle' --expect body=N
```

`update` reads `N` with `show` before the timed region. `list` and `search` return 50 issues. Each run has one unrecorded warmup round and then 15 rounds. The command order rotates in each round, and the store order alternates.

The harness starts Node by its absolute path. On this host, a `spawnSync('node', ...)` lookup through `PATH` added about 15 to 20 ms to each start.

macOS `/usr/bin/time` has no `-f` option. The `/usr/bin/time -f '%U %S'` command above works only with GNU time.

### Git on macOS

`/usr/bin/git` on macOS is a shim that finds the Xcode or Command Line Tools Git and runs it. The CLI starts Git once per command. After a process starts the shim, the next process start on this host takes about 30 to 70 ms longer. The direct Git binary, `$(xcrun --find git)`, does not cause this delay.

A probe recorded `performance.timeOrigin` in the child process and compared it with the spawn time in the parent:

- `node -e 0` after another `node -e 0`: about 14 ms from spawn to `timeOrigin`.
- `node -e 0` after a process that ran `/usr/bin/git rev-parse`: 44 to 85 ms.
- `node -e 0` after a process that ran the direct Git binary: 12 to 14 ms.

Most of the delay falls on the next process. The process that starts the shim pays only about 4 to 6 ms more than with the direct binary. In a sequence of `pd` commands, each command after the first pays the delay of the command before it. A plain zsh loop of 20 `pd show` runs took 1.68 s with `/usr/bin/git` and 0.99 s with the direct Git, about 84 ms and 50 ms per command.

### Results

The run was done twice: once with the default `PATH`, and once with the direct Git directory first on `PATH`. Wall-clock times are milliseconds, 15 samples each.

| command | store | `/usr/bin/git` median | min | max | direct Git median | min | max |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| list | small | 89.3 | 86.6 | 94.1 | 53.3 | 51.8 | 54.2 |
| search | small | 90.0 | 88.3 | 94.4 | 54.8 | 53.5 | 56.2 |
| show | small | 88.4 | 85.5 | 92.0 | 52.6 | 50.0 | 53.7 |
| create | small | 88.8 | 86.5 | 95.9 | 52.6 | 51.1 | 54.3 |
| comment | small | 88.6 | 86.6 | 92.1 | 52.6 | 51.9 | 54.8 |
| update | small | 86.4 | 84.4 | 100.6 | 53.1 | 51.4 | 55.2 |
| list | large | 88.1 | 86.2 | 90.1 | 52.6 | 51.9 | 54.0 |
| search | large | 90.8 | 88.5 | 97.7 | 54.1 | 52.5 | 55.5 |
| show | large | 88.2 | 86.5 | 108.4 | 52.4 | 51.5 | 54.2 |
| create | large | 89.6 | 86.5 | 96.7 | 53.8 | 51.7 | 55.7 |
| comment | large | 88.3 | 86.8 | 91.2 | 53.0 | 51.8 | 54.3 |
| update | large | 86.3 | 84.0 | 101.0 | 53.6 | 50.6 | 55.5 |
| `node -e 0` | none | 53.7 | 52.0 | 62.0 | 27.0 | 25.2 | 28.1 |
| `pd --version` | none | 27.0 | 26.0 | 29.3 | 29.4 | 27.2 | 32.3 |

`node -e 0` is the first process of each round, so it follows the last command of the round before. `pd --version` follows `node -e 0` and does not start Git, so the shim delay does not reach it.

### What the local numbers show

- With the direct Git, every measured command takes 52 to 55 ms at the median. The min-to-max spans are 3 to 5 ms wide.
- The small and the large store give the same times within 2 ms. At these sizes, the store size does not change the latency of these commands.
- With `/usr/bin/git`, every command takes about 35 ms more. The spans of the two variants do not overlap on any row. This cost comes from the macOS Git shim, not from SQLite or from the CLI code.
- In one `show` process, about 40 ms passes between `timeOrigin` and the `exit` event. A Node CPU profile of `list` totals about 42 ms. `runBootstrap` takes 28 ms of it, and module loading takes about 15 ms of that. The Git `spawnSync` takes about 7 ms.

The numbers do not show how the CLI behaves on Linux, under heavy load, or with stores larger than 2,500 issues.

## Cloud latency

This run measures the deployed pd1 Worker and its D1 database from the same host, right after the local run. `GET /v1/version` reported package 0.5.2, commit `def7a9c`, and schema 9. The one-minute load average was 2.28 before the run and 2.44 after it.

### Procedure

The harness reads the cloud origin from `pd connection list` and gets an access token from the existing CLI login. It does not print the origin or the token. It sends requests with `fetch` from one Node process, so all requests after the first reuse one connection.

- `/v1/operations`: the same headers as the CLI, and the operation as the body.
- `/mcp`: a JSON-RPC `tools/call` request with `accept: application/json, text/event-stream`. The request has no `initialize`, because the Worker handles each call alone.
- Writes go to a scratch project, `polylinedb-bench`. The run creates five issues: three through `/v1/operations` and two through `/mcp`.
- Reads: 20 rounds. Each round runs `list --project polylinedb-bench --limit 50`, `search` for a token that only the five issues contain, and `show` on both endpoints. The endpoint order alternates.
- Writes: 5 `comment` and 5 `update` calls on each endpoint, on the scratch issues only. `update` reads the version with a `show` that is outside the timed region.

Each sample is the time from the start of `fetch` to the end of the response body.

### Server-Timing

`/mcp` responses carry `Server-Timing: worker;dur=N`. `/v1/operations` and `/v1/version` responses do not carry it. The Worker clock advances only across I/O, so `dur` is the time that the Worker waits on Access keys and D1.

### Results

Wall-clock times are milliseconds.

| request | endpoint | n | median | min | max | Worker `dur` median (min to max) |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| list | `/v1/operations` | 20 | 77.9 | 60.0 | 94.1 | not reported |
| list | `/mcp` | 20 | 74.7 | 60.5 | 135.2 | 38 (30 to 84) |
| search | `/v1/operations` | 20 | 79.5 | 66.1 | 115.2 | not reported |
| search | `/mcp` | 20 | 111.9 | 91.6 | 304.3 | 66 (52 to 120) |
| show | `/v1/operations` | 20 | 94.6 | 78.9 | 146.3 | not reported |
| show | `/mcp` | 20 | 98.9 | 78.7 | 149.0 | 55.5 (47 to 93) |
| create | `/v1/operations` | 3 | 89.0 | 79.3 | 116.1 | not reported |
| create | `/mcp` | 2 | 89.9 | 87.8 | 91.9 | 47.5 (44 to 51) |
| comment | `/v1/operations` | 5 | 79.2 | 69.4 | 81.7 | not reported |
| comment | `/mcp` | 5 | 84.9 | 70.5 | 97.0 | 46 (37 to 55) |
| update | `/v1/operations` | 5 | 83.7 | 81.2 | 93.1 | not reported |
| update | `/mcp` | 5 | 82.0 | 75.8 | 84.3 | 41 (39 to 44) |
| version, first request | `/v1/version` | 1 | 627.3 | | | not reported |
| version, warm | `/v1/version` | 5 | 68.7 | 62.0 | 96.8 | not reported |

The create rows have only two or three samples.

### The CLI against the cloud

Ten runs each of `pd --connection pd1 list --project polylinedb-bench --limit 50` and `pd --connection pd1 show ID` had these wall-clock times:

| command | median | min | max |
| --- | ---: | ---: | ---: |
| list | 328.3 | 297.2 | 809.5 |
| show | 335.2 | 288.2 | 471.9 |

A probe split one process into parts, six times:

- Module imports: 14 to 22 ms.
- Token read from the credential store, including the `/usr/bin/security` child: 12 to 15 ms.
- The first `list` request on a new connection: 175 to 415 ms, median about 195 ms.
- A second `list` request on the same connection: 59 to 100 ms.

`NODE_USE_SYSTEM_CA` did not change the first request time. The CLI runs used the default `PATH`, so each one also includes the `/usr/bin/git` shim delay from the run before, about 30 ms. The probe parts and the Node startup add up to about 250 ms. The CLI bootstrap, its Git start, and the shim delay make up most of the rest of the 330 ms median.

### What the cloud numbers show

- On a warm connection, a read or a write through either endpoint takes about 75 to 100 ms at the median. The Worker waits on Access and D1 for about 40 to 65 ms of that time. The one exception is `search` through `/mcp`, at 112 ms.
- `search` through `/mcp` is about 30 ms slower than through `/v1/operations`. `/mcp` always asks for `with_matches`, and the `dur` of search is higher than the `dur` of list.
- Each CLI process opens a new connection. Connection setup adds about 100 to 300 ms to the first request. This is the largest part of a cloud CLI command, larger than Node startup, module loading, and the token read together.

The numbers are from one client location and one time of day. They do not show D1 latency under concurrent load, or the latency from other networks.

## Limitation

finderscope `run` turns on Node's CPU profiler through `NODE_OPTIONS`. `finderscope run -- /bin/true` writes no profile and reports that the command may not have run Node. The M4 profiles above use `node --cpu-prof` directly.
