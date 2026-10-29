---
name: polylinedb-queue
description: Enqueue finished commits onto the shared queue branch, the standard landing path. Do not push or merge main.
---

# Enqueue onto the queue branch

The `queue` branch is the standard landing path.
Agents enqueue finished commits onto `queue`. The owner, or rocky with the owner's standing permission, lands `queue` onto main.
Other agents never push or merge main and never take the `main-lock` issue.
The polylinedb skill covers selection and claims. This skill covers the worktree, the push, and the issue state after it.
Use the selected MCP connector's advertised tools and argument schemas.
If the connector does not advertise a tool that this skill names, stop and report the gap. Do not substitute another tool.
Keep the same connector and explicit project throughout the work.
This skill does not grant permission to publish. Follow the user's authorization boundary before an external write.
A release is a version bump that lands on main through `queue`, as `docs/releasing.md` in the repository describes. Never push a release tag or run `npm publish` by hand.

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

## Keep pd issue ids out of git

Only the owner's agents can read pd, so a pd issue id in git means nothing to other readers.
Never write a pd issue id, such as `pd-149` or `pd-65.3`, into a commit message. Describe the change in words.
The link between an issue and its commits lives in pd, as the `tip:` comment on the issue, not in git.
The check workflow rejects a pushed commit whose message names a pd issue id.

## Rebase and push the queue branch

Any number of agents may push `queue` at the same time. There is no queue lock.
The rejected-push loop below handles the race.

Fetch `queue` and rebase the finished commits onto it.
If the rebase conflicts, finish it. Resolve the conflicts in the code.
`CHANGELOG.md` and `CHANGELOG.human.md` conflicts are expected. Keep both entries.
Do not stop and ask a human only because the rebase conflicted, and do not abort the rebase.
After a conflict, rerun the affected tests. If they fail, fix the fallout of the resolve and run them again.

After the final rebase, run the full test suite on the rebased commits before you push `queue`.
A failure on the queue tip blocks the push too. Fix it, or report it and do not push.
Report test counts only from this post-rebase run. A run from before the rebase does not count.

Push `queue`. Do not use `--force` or `--force-with-lease`.
If the push is rejected, fetch, rebase onto the fetched branch, resolve again the same way, rerun the full suite, and push again.
Never rewrite commits that other agents pushed.

## Stop only your own processes

Other agents may run tests in the same container.
Never kill processes by pattern, as with `pkill -f`, `killall`, or `kill $(pgrep ...)`.
Kill only the PIDs that you started.

## Keep the claim

The claim TTL is at most 3600 seconds.
Between long steps, read `claim_show` for the revision and call `claim_renew` with the issue proof.
Cloud agents renew through the MCP connector. Do not log in to the CLI with owner credentials to renew.
Before the handoff, call `claim_report` with `kind: done` and one line; it needs no revision.

## Record the enqueue

After a successful push, verify the remote queue tip.
The agent must hold the claim on the issue while it writes these records. An agent can `comment` and `update` only with that claim; otherwise the write fails with `claim_required`.
If this session's lease expired after the push, acquire the issue again and then write the records.
Do not acquire an issue this session did not push, only to write these records.
A cloud connector reports a human actor until per-agent tokens exist and does not enforce the agent gate. Hold the claim there too.

Hand the issue off with one `claim_handoff` call.
Pass the issue proof, the current claim revision as `expected_revision`, a new request UUID, `tip` set to the 40-character SHA of the queue tip, and `summary` set to the changed paths, commit SHAs, and verification result.
In one atomic write it adds the `tip: <sha>` comment and the summary comment, sets status `open`, removes `ready`, adds `main-wait`, keeps the other labels, and releases the claim.
If any part fails, nothing is written. After an uncertain response, call it again with the same request UUID and the same arguments; it returns the first result.

When the result carries a non-empty `land_order_warnings`, report each `id` and `status` to the user: this issue should land after those issues, and they have not reached the queue yet.
Do not reorder `queue`, revert the push, or undo the handoff because of it. The person who lands `queue` decides.

When the connection has no `claim_handoff`, write the same records in four steps:

1. Write a `comment` whose whole body is `tip: ` followed by the 40-character SHA of the queue tip. It holds only that line, with no reasoning and no tool output.
2. Write a second `comment` with the changed paths, commit SHAs, and verification result.
3. Read field versions with `show`. Then `update` the issue with the issue proof: status `open`, labels without `ready` and with `main-wait`. Keep the other labels.
4. Release the claim with `claim_release`.

Do not `close` the issue. Do not write priority.
Whoever lands `queue` onto main closes the issue.
A drain is done on the agent side when every issue is enqueued, `open`, labeled `main-wait`, and unclaimed.
The issues close later, when `queue` lands on main.

Notes stay in pd, as a `comment` or as project memory.
Do not use git notes.

If the push succeeds but a later write fails, report the remote SHA and reconcile the records before declaring the enqueue complete.
Never repeat a successful push merely because a later write failed.

## Write the changelog entries in the work commit

Each work commit carries its own changelog entries, so a landing adds no commit and no extra Check run.
`CHANGELOG.md` is the agent changelog. `CHANGELOG.human.md` is the changelog for people.
Add the change under `## Unreleased` in both files, in the same commit as the change.
The `CHANGELOG.md` entry describes the change in words and names MCP and CLI behavior, return fields, error and no-op semantics, required Worker secrets and bindings, D1 schema versions and migrations, and deploy prerequisites.
The `CHANGELOG.human.md` entry says in a few plain sentences what people can now do or what changed in `/ui` and the workflow, without internals.
Name Worker secrets and bindings only by name. Never write secret values, tokens, account IDs, or webhook URLs into either file.
Never write pd issue ids, such as `pd-149`, into either file, including under `## Unreleased`. Readers cannot open pd, so describe the change in words.
A release commit turns `## Unreleased` into a version section, as `docs/releasing.md` describes.
Nobody adds a landing-record commit. The `## Main landings` section of `CHANGELOG.md` and the dated landing entries of `CHANGELOG.human.md` are history.

## Land queue onto main

The owner lands `queue` onto main. Rocky, the owner's landing agent, has the owner's standing permission to land without asking each time.
Rocky lands only under the `main-lock` claim, and only a queue tip whose Check workflow succeeded on that exact commit.

1. Acquire the `main-lock` issue as `docs/claims.md` describes.
2. Fetch `main` and `queue`. Confirm that `main` is an ancestor of the queue tip and that Check succeeded on the queue tip SHA.
3. Push that SHA to main as a fast-forward, for example `git push origin SHA:refs/heads/main`. Never force.
4. For each `main-wait` issue that is now on main, claim it, remove `main-wait`, close it with the current proof, and release the claim.
5. Release the main-lock.

Check does not run again on main, because it already passed on the same commit in `queue`.
A push to main that changes `package.json` starts the Publish workflow. Only the owner approves its `publish` environment.
Rocky does not tag, publish by hand, or deploy. Other agents never push main and never take the main-lock.
