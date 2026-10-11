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

## Limitation

finderscope `run` turns on Node's CPU profiler through `NODE_OPTIONS`. `finderscope run -- /bin/true` writes no profile and reports that the command may not have run Node. This page has no Cloudflare Worker or D1 timings.
