# Keep one Git repository answer per directory

Status: accepted.

## Problem

`repository()` in `src/workspace/local-config.ts` starts Git with `rev-parse` on every call.
A local command calls it for the same directory from `readRepositoryDefaults`, `repositoryConfigPath`, and `validateExternalDirectory`.
`validateExternalDirectory` runs for the configuration directory and again for each local connection.
Before the cache, `create` and `list` with a named local connection each started that same Git command four times.
Each start is a process. The command does not need a new answer between those calls.

## Decision

Keep the first answer for a canonical directory for the life of the process.
The key is `realpath` of the directory passed to `repository()`.
Git remains the authority.
The arguments stay `rev-parse --is-inside-work-tree --show-toplevel --git-common-dir`.
The environment filter stays the same: drop every `GIT_*` variable, then set `GIT_CONFIG_NOSYSTEM` and `GIT_CONFIG_GLOBAL`.

Cache two successful answers.
A repository answer is the work tree root and the common metadata directory.
An answer that the directory is not a repository is `undefined`, including Git exiting with status 128.
Do not cache a thrown error.
A missing Git binary, an unexpected Git failure, and metadata that fails validation throw, so the next call in the process starts Git again.
A failure can be temporary. Remembering it would make a later call fail without asking Git.
Do not reuse an answer for a different directory.
A symlink and its target share one answer because both keys are the real path.

The cache stays in `src/workspace/local-config.ts`.
The Worker does not import that module.

## Consequences

A local command pays for one Git start per directory instead of one start per reader.
Worktree resolution, repository defaults, external-directory validation, connection precedence, and the `GIT_*` override behavior stay.
The answer can go stale inside one process.
A directory that was not a repository stays not a repository until the process exits, even if Git metadata appears later.
A repository that moves its common directory stays at the first answer.
Each CLI command is a new process, so the next command sees the current Git state.
Installing Git, or correcting `PATH`, lets a later call in the same process succeed, because the failure was not cached.

[Local Git lookup cost](../performance.md) records how to count the starts.
Cloud latency was not measured for this decision.
