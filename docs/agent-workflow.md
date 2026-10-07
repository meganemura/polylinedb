# Agent workflow contract

The bundled skill uses MCP operation names and schemas across connectors.
It keeps candidate order in session memory as `recommended_ids`.
The order helps selection. The claim gate owns the readiness and holder decision.
Agents refetch ready candidates before each claim attempt because another actor can change prerequisites or ownership after ranking.

The current MCP vocabulary represents ready work as `dependency_worklist` with `state: "ready"`.
`claim_show`, `claim_acquire`, `claim_renew`, and `claim_release` supply the issue lease lifecycle.
The skill reads schemas at runtime and uses separate issue and main-lock proofs.
Repository publication policy selects main-direct or PR work.

The current claim acquisition contract checks claim availability.
The atomic ready-only gate, main-lock, and issue pointer contracts require companion implementation work.
Until those contracts are advertised, the skill can retrieve, rank, and claim candidates with fresh readiness observations.
Those observations cannot guarantee atomic ready-only acquisition.
Publication that requires unavailable lock or pointer contracts stops with local commits intact.
This boundary preserves the existing mutation APIs while the coordination contracts develop.

A verified remote SHA precedes a pointer write because a local commit does not establish a remote tip.
The main-lock covers reconciliation, push, and the pointer write.
Completion closes the issue before releasing its lease because close requires a current ownership proof.
For a handoff, the agent records progress and releases the lease while leaving the issue open.
