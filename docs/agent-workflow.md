# Agent workflow contract

The bundled skill uses MCP operation names and schemas across connectors.
It keeps candidate order in session memory as `recommended_ids`.
The order helps selection. The claim gate owns the readiness and holder decision.
Agents refetch ready candidates before each claim attempt because another actor can change prerequisites or ownership after ranking.

The current MCP vocabulary represents ready work as `dependency_worklist` with `state: "ready"`.
`claim_show`, `claim_acquire`, `claim_renew`, and `claim_release` supply the issue lease lifecycle.
`claim_report` records one line about the holder's work under the proof alone, and `claim_show` returns it as `claim.run`.
The skill reads schemas at runtime.
Agents enqueue finished work on the shared `queue` branch. The owner, or rocky with the owner's standing permission, lands `queue` onto main under the main-lock once Check is green on the queue tip.
Other agents do not push main or take the main-lock.

A successful `claim_acquire` returns `open_blockers`, the ids of active blockers, observed at acquire time.
An empty list means there are none.
Acquire does not fail because of those blockers.
If `open_blockers` is non-empty and the claim was meant to start work, release immediately and pick another issue from the ready worklist.
It also returns `open_asks`, the asks on the issue that wait for a person's answer.
An agent actor claims only issues labeled `ready`, and the store checks that label in the same transaction as the acquisition.
An agent update, close, reopen, comment, item write, or prerequisite edit succeeds only while the agent holds an active claim on the issue, checked in the same transaction as the write.

An agent that needs a person's decision adds an ask with `item_add` and keeps its claim.
The ask takes the issue off the ready worklist and lists it in owner waits and the `/ui` You lane.
The agent reports `blocked` with `claim_report` and waits for the `answered` event from the `wait_from` position that `item_add` returned.
A person answers on the `/ui` page or through a human actor that did not ask; an agent cannot answer.
An acceptance condition is a check, which the agent meets with an evidence line.
`close` and `claim_handoff` refuse with `items_open` while an ask is open or a check is unmet.
[Coordinate issue ownership](claims.md#ask-a-person-and-check-the-result) has the rules and their limits.
An agent asks instead of adding `owner-decision` or `owner-action`. Those labels still mark an issue that waits on the owner, for an issue that is itself the owner's work and for issues labeled before asks existed.
Local connections set the agent kind and actor per host, as [local agent actors](agent-actors.md) describes.
Cloud connections derive a human actor from authentication until per-agent tokens exist, so the agent gates do not apply there yet.

`recommended_ids` is a preference order only.
A ready ID that the order omits stays claimable, and the skill never limits its choice to the order.
The ready worklist leaves out issues labeled `main-lock`, so the repository lock issue never enters the ranking.
The main-lock is a short claim on that lock issue, found with `list` and the `main-lock` label, and serializes the owner's pushes to main.
The issue pointer is a comment from the claim holder whose whole body is `tip: <40-character SHA>`.

A verified remote SHA precedes the tip comment because a local commit does not establish a remote tip.
Any number of agents may push `queue` without force at the same time. A rejected push leads to fetch, rebase, conflict resolution, and another push, so `queue` needs no lock.
After the enqueue, the agent sets the issue `open`, replaces `ready` with `main-wait`, and releases the lease.
Whoever lands `queue` onto main claims the issue again, closes it, and then releases that claim.
Close comes first, because close requires the current proof.
Each work commit adds its own entry under `## Unreleased` in both changelogs: [CHANGELOG.md](../CHANGELOG.md) for agents, with fields, errors, secrets by name, schema, and deploy steps, and [CHANGELOG.human.md](../CHANGELOG.human.md) for people, in plain English.
A landing adds no changelog commit, so it starts no extra Check run. Check does not run on main, which only receives queue tips that already passed it.
Neither changelog names pd issue ids, because readers cannot open pd. Each entry describes the change in words.
Commit messages follow the same rule: they describe the change in words and never name a pd issue id. The `tip:` comment on the issue links pd to git.
The `commit-messages` job in `.github/workflows/check.yml` runs `scripts/commit-messages.ts` on the pushed range only, so earlier history is not checked again.
The Check workflow runs each OS and Node pair as four parallel jobs: `static` (typecheck, architecture, `/ui` latency), `unit` (`npm test`), `d1` (`npm run test:d1`), and `package` (Worker build, Worker integration, package test). A landing waits for the whole run to succeed, not for a job name.

Cloud agents use Node 24 for local tests. Use Node 24.20.0 or a later Node 24 release to meet `package.json` `engines.node`.
Test commands stop before tests start on an unsupported runtime and print the actual version and required range.

For a handoff, the agent records progress and releases the lease while leaving the issue open.

## `/ui` latency budget

[Measure `/ui` latency](ui-latency.md) sets the budget for the Worker `/ui` pages.
`npm run check:ui-latency` is a required check for a change that touches those pages.
The Check workflow runs it on every push except to main, and on every pull request.
A budget miss fails the change.
A feature that cannot meet the budget needs an owner decision before it lands.
