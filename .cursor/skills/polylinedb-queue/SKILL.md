---
name: polylinedb-queue
description: Enqueue finished commits onto the shared queue branch. Use only for that enqueue. Do not merge to main.
---

# Enqueue onto the queue branch

Use this skill only when enqueueing finished commits onto the queue branch.
The ordinary flow stays in the polylinedb skill: branch `work/<issue id>`, claim the `main-lock` issue, and land on main.
This skill does not change those steps.
Use the selected MCP connector's advertised tools and argument schemas.
If the connector does not advertise a tool that this skill names, stop and report the gap. Do not substitute another tool.
Keep the same connector and explicit project throughout the work.
This skill does not grant permission to publish. Follow the user's authorization boundary before an external write.

## Use the queue branch

The queue is one shared branch named `queue`.
Every agent uses that name. Do not choose a different name for an agent or a run.

Immediately before enqueue, confirm the remote branch, for example with `git ls-remote --heads origin queue`.
If `queue` does not exist on the remote, create it from the current main and push it, for example `git fetch origin main` and `git push origin origin/main:refs/heads/queue`.
Do not use `--force` or `--force-with-lease`.
If that push is rejected, fetch `queue` and use the branch that is already there.

Worktrees are optional. Do not require a branch named `work/<issue id>`.

## Rebase and push the queue branch

Rebase the finished commits onto the fetched `queue` branch.
Running tests locally is optional.
If the rebase conflicts, stop and say so. Abort the rebase. Do not resolve the conflicts or push.

Push `queue`. Do not use `--force` or `--force-with-lease`.
If the push is rejected, fetch, rebase onto the fetched branch, and push again.
If that rebase conflicts, stop and say so. Abort the rebase. Do not resolve it.

Pushing `queue` is what this skill is for.
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

If the push succeeds but the pointer write fails, report the remote SHA and reconcile the pointer before declaring the enqueue complete.
Never repeat a successful push merely because a later write failed.
