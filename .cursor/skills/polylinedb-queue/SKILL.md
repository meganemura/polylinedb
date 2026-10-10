---
name: polylinedb-queue
description: Enqueue finished commits onto the one queue branch named in project memory. Use only for that enqueue. Do not merge to main.
---

# Enqueue onto the queue branch

Use this skill only when enqueueing finished commits onto the queue branch.
The ordinary flow stays in the polylinedb skill: branch `work/<issue id>`, claim the `main-lock` issue, and land on main.
This skill does not change those steps.
Use the selected MCP connector's advertised tools and argument schemas.
If the connector does not advertise a tool that this skill names, stop and report the gap. Do not substitute another tool.
Keep the same connector and explicit project throughout the work.
This skill does not grant permission to publish. Follow the user's authorization boundary before an external write.

## Read the queue branch

The queue is one branch. A human chooses its name and writes it in project memory.
Agents never invent that name and never call `memory_create` or `memory_update` for it.

The memory title is `queue-branch`.
That title is fixed, the way `main-lock` is a known issue.
The memory `body` is the branch name and nothing else.

Immediately before enqueue, read that memory. A session-start `memory_context` is not enough.
Call `memory_context` with the project and `with_revision: true`. Retain `memory_revision`.
Find the entry with `memory_search` and `query` `queue-branch`. Follow `next_cursor` with `after`.
Accept only a memory whose `title` is exactly `queue-branch`. Search matches a literal substring, so keep going until the exact title appears or the pages end.
If more than one memory has that exact title, stop and ask a human.
If none exists, stop and ask a human to create it. Do not create it.

Call `memory_show` with that `id` and the project, and use the returned `body` as the branch name.
If the body is not a single branch name, with no whitespace and no second line, stop and ask. Do not trim, split, or invent a name.

`memory_revision` is the project token from `memory_context` with `with_revision: true`.
Compare that token with the last read. Pass `observed_memory_revision` only to issue operations that accept it.
If the token moved since the last read, call `memory_context` with `with_revision: true` and `memory_show` again before using the branch name.
A moved token covers the whole project, including entries a context page omitted.
Replace the retained token only from that new `memory_context`. A `memory_freshness` result never advances it.
After `memory_freshness` `stale` or `unavailable`, read the memory again before a decision that depends on it.
Read again immediately before the push when the token has moved since the rebase.
If a re-read returns a different branch name, stop and ask.

## Use the human's remote branch

A human creates that remote branch once, from main.
Immediately before enqueue, confirm the remote branch exists, for example with `git ls-remote --heads origin BRANCH`.
If it does not exist, stop and ask a human to create it from main. Do not create it.

Worktrees are optional. Do not require a branch named `work/<issue id>`.

## Rebase and push the queue branch

Rebase the finished commits onto the fetched queue branch.
Running tests locally is optional.
If the rebase conflicts, stop and say so. Abort the rebase. Do not resolve the conflicts or push.

Push that queue branch. Do not use `--force` or `--force-with-lease`.
If the push is rejected, fetch, rebase onto the fetched branch, and push again.
If that rebase conflicts, stop and say so. Abort the rebase. Do not resolve it.

Pushing that one queue branch is what this skill is for.
Do not push any other branch, and do not treat this as permission to push main.
Do not merge to main. Do not take the `main-lock` issue.

## Record the queue tip

After a successful push, verify the remote queue tip.
The agent must already hold the claim on the issue. An agent can `comment` only with that claim; otherwise the write fails with `claim_required`.
If the agent does not hold the claim, stop. Do not acquire a claim, and do not take the `main-lock` issue, in order to comment.
A cloud connector reports a human actor until per-agent tokens exist and does not enforce the agent gate. Hold the claim before `comment` on that connector too.

Write a `comment` on the claimed issue whose whole body is `tip: ` followed by the 40-character SHA of the queue branch.
The comment holds only that line, with no reasoning and no tool output.
Leave the issue open. Do not `close` it. Do not write priority.

Notes stay in pd, as a `comment` or as project memory.
Do not use git notes.
Do not create or update the `queue-branch` memory.

If the push succeeds but the pointer write fails, report the remote SHA and reconcile the pointer before declaring the enqueue complete.
Never repeat a successful push merely because a later write failed.
