---
name: polylinedb-queue
description: Enqueue finished commits onto the shared queue branch, the standard landing path. Do not push or merge main.
---

# Enqueue onto the queue branch

The `queue` branch is the standard landing path.
Agents enqueue finished commits onto `queue`. The owner lands `queue` onto main.
Agents never push or merge main and never take the `main-lock` issue.
The polylinedb skill covers selection and claims. This skill covers the worktree, the push, and the issue state after it.
Use the selected MCP connector's advertised tools and argument schemas.
If the connector does not advertise a tool that this skill names, stop and report the gap. Do not substitute another tool.
Keep the same connector and explicit project throughout the work.
This skill does not grant permission to publish. Follow the user's authorization boundary before an external write.

## Use the queue branch

The queue is one shared branch named `queue`.
Every agent uses that name. Do not choose a different name for an agent or a run.

Confirm the remote branch, for example with `git ls-remote --heads origin queue`.
If `queue` does not exist on the remote, create it from the current main and push it, for example `git fetch origin main` and `git push origin origin/main:refs/heads/queue`.
Do not use `--force` or `--force-with-lease`.
If that push is rejected, fetch `queue` and use the branch that is already there.

## Branch from the queue tip

After the claim, fetch `queue` and branch the worktree from its current tip, for example `git worktree add ../work-ISSUE_ID -b work/ISSUE_ID origin/queue`.
Starting from the queue tip avoids most rebase conflicts with work that is already enqueued.

You may push `work/<issue id>` without force to keep finished commits on the remote before the queue push.
Push no branch other than `work/<issue id>` and `queue`.

## Rebase and push the queue branch

Any number of agents may push `queue` at the same time. There is no queue lock.
The rejected-push loop below handles the race.

Fetch `queue` and rebase the finished commits onto it.
If the rebase conflicts, finish it. Resolve the conflicts in the code.
`CHANGELOG.md` conflicts are expected. Keep both entries.
Do not stop and ask a human only because the rebase conflicted, and do not abort the rebase.
After a conflict, rerun the affected tests. If they fail, fix the fallout of the resolve and run them again.

Push `queue`. Do not use `--force` or `--force-with-lease`.
If the push is rejected, fetch, rebase onto the fetched branch, resolve again the same way, and push again.
Never rewrite commits that other agents pushed.

## Keep the claim

The claim TTL is at most 3600 seconds.
Between long steps, read `claim_show` for the revision and call `claim_renew` with the issue proof.
Cloud agents renew through the MCP connector. Do not log in to the CLI with owner credentials to renew.

## Record the enqueue

After a successful push, verify the remote queue tip.
The agent must hold the claim on the issue. An agent can `comment` and `update` only with that claim; otherwise the write fails with `claim_required`.
If the agent does not hold the claim, stop. Do not acquire a claim only to write these records.
A cloud connector reports a human actor until per-agent tokens exist and does not enforce the agent gate. Hold the claim there too.

1. Write a `comment` whose whole body is `tip: ` followed by the 40-character SHA of the queue tip. It holds only that line, with no reasoning and no tool output.
2. Write a second `comment` with the changed paths, commit SHAs, and verification result.
3. Read field versions with `show`. Then `update` the issue with the issue proof: status `open`, labels without `ready` and with `main-wait`. Keep the other labels.
4. Release the claim with `claim_release`.

Do not `close` the issue. Do not write priority.
Whoever lands `queue` onto main closes the issue.
A drain is done on the agent side when every issue is enqueued, `open`, labeled `main-wait`, and unclaimed.
The issues close later, when the owner lands `queue`.

Notes stay in pd, as a `comment` or as project memory.
Do not use git notes.

If the push succeeds but a later write fails, report the remote SHA and reconcile the records before declaring the enqueue complete.
Never repeat a successful push merely because a later write failed.
