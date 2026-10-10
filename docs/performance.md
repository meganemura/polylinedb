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

## Limitation

Cloud latency was not measured here.
