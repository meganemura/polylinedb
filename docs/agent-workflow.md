# Agent workflow contract

The bundled skill uses MCP operation names and schemas across connectors.
It keeps candidate order in session memory as `recommended_ids`.
The order helps selection. The claim gate owns the readiness and holder decision.
Agents refetch ready candidates before each claim attempt because another actor can change prerequisites or ownership after ranking.

The current MCP vocabulary represents ready work as `dependency_worklist` with `state: "ready"`.
`claim_show`, `claim_acquire`, `claim_renew`, and `claim_release` supply the issue lease lifecycle.
The skill reads schemas at runtime and uses separate issue and main-lock proofs.
Repository publication policy selects main-direct or PR work.

An agent actor claims only issues labeled `ready`, and the store checks that label in the same transaction as the acquisition.
An agent update, close, reopen, comment, or prerequisite edit succeeds only while the agent holds an active claim on the issue, checked in the same transaction as the write.
Local connections set the agent kind and actor per host, as [local agent actors](agent-actors.md) describes.
Cloud connections derive a human actor from authentication until per-agent tokens exist, so the agent gates do not apply there yet.

`recommended_ids` is a preference order only.
A ready ID that the order omits stays claimable, and the skill never limits its choice to the order.
The ready worklist leaves out issues labeled `main-lock`, so the repository lock issue never enters the ranking.
The main-lock is a short claim on that lock issue, found with `list` and the `main-lock` label.
The issue pointer is a comment from the claim holder whose whole body is `tip: <40-character SHA>`.

A verified remote SHA precedes the tip comment because a local commit does not establish a remote tip.
The main-lock covers reconciliation, push, and the tip comment.
Completion closes the issue before releasing its lease because close requires a current ownership proof.
For a handoff, the agent records progress and releases the lease while leaving the issue open.
