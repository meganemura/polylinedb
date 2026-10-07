# Advertise MCP hints from the repeat behavior of each operation

Status: accepted.

## Problem

Each MCP tool advertises `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`.
The first values were conservative.
`dependency_list` and `dependency_worklist` advertised `readOnlyHint: false`, but they only read records.
`create`, `memory_create`, and the prerequisite edits advertised `idempotentHint: false`, but a required request UUID replays their receipt.
`dependency_remove` advertised `destructiveHint: false`, but it deletes a prerequisite edge.

A client can use these hints to decide when to confirm a call or to repeat a call.
A false `readOnlyHint` on a read makes a client ask for a confirmation that has no purpose.
A hint that promises more than the store does can make a client repeat a write that adds a second record.

## MCP meaning

MCP protocol version `2025-11-25` defines the hints in its `ToolAnnotations` schema:

- `readOnlyHint: true` means that the tool does not modify its environment.
- `destructiveHint: true` means that the tool may perform destructive updates. `false` means that the tool performs only additive updates.
- `idempotentHint: true` means that a repeated call with the same arguments has no additional effect on the environment.
- `openWorldHint: false` means that the tool's domain of interaction is closed.

`destructiveHint` and `idempotentHint` have a meaning only when `readOnlyHint` is false.
The schema calls all annotations hints, and it tells clients to trust them only from trusted servers.

## Decision

The hints describe the effect of a call on the store.
They do not describe the response.

**Reads.** Every read operation advertises `readOnlyHint: true`, `destructiveHint: false`, and `idempotentHint: true`.
A read can return a different result at a later time.
`claim_show` reports database time and lease expiry, and `dependency_worklist` reports readiness as an observation.
A change in a result is not an effect of the read, so these reads keep `readOnlyHint: true`.

**Receipt replay.** `create`, `memory_create`, `dependency_add`, `dependency_remove`, and the three claim mutations require a request UUID.
The first successful call stores an immutable receipt for that UUID in the same transaction as the write.
A repeat with the same UUID and the same payload from the same actor returns the stored receipt and writes nothing.
A repeat with the same UUID and a different actor or payload fails with `request_conflict`, `dependency_request_conflict`, or `claim_request_conflict`, and it writes nothing.
The store keeps every receipt, and snapshots carry the receipts to a restored store.
So these operations advertise `idempotentHint: true`.

**Version checks.** `update`, `close`, `reopen`, `memory_update`, and `memory_delete` require the version that the caller observed.
A successful write increments the version, or it deletes the memory.
Versions only increase, and the store does not reuse a memory ID.
So a repeat with the same arguments fails with a conflict or `not_found`, and it writes nothing.
These operations advertise `idempotentHint: true`.

A repeat after a lost success response does not return the original result.
It returns the conflict, and the caller cannot see from the conflict whose write the store accepted.
Read the record before you decide on a new write.
The hint does not change this rule.

**Rejected calls.** A call that the store rejects has no effect.
A later call with the same arguments is a new attempt against the current state.
For example, a close that failed with `dependency_blocked` can succeed after the blocker closes.
The hint promises only that a repeat adds nothing to a call that the store accepted.

**Comments.** `comment` has no request UUID and no version check.
Each call appends a new comment, so `comment` advertises `idempotentHint: false`.
It is the only mutation that a repeat can duplicate.
After an uncertain comment result, read the issue before you decide whether to comment again.

**Destructive updates.** A mutation advertises `destructiveHint: true` when it can remove or replace current state that other callers read.
Issue field writes, memory edits, prerequisite removal, and claim release do this.
Creation, comments, prerequisite addition, claim acquisition, and claim renewal add records or extend the caller's own lease, so they advertise `destructiveHint: false`.
Claim acquisition succeeds only when the issue has no active lease, so it does not take ownership from another session.

**Closed domain.** Every tool advertises `openWorldHint: false`, because each tool acts only on the store.

## Actor requirement

The operation policy has one row per operation.
Each row records the local access level and the MCP hints as separate fields.
The CLI requires an explicit local actor for an operation whose access level is `write`.
The Worker rejects a `write` operation from a `reader` actor.
Both checks read the access level field of the row.
So a change to a hint does not change who must name an actor.

## Verification

`test/worker.test.ts` calls every tool through the MCP endpoint against a real SQLite store.
It compares the contents of every table before and after each call.
A read must leave the store unchanged.
An operation that advertises `idempotentHint: true` must leave the store unchanged on a repeat with the same arguments.
`comment` must change the store on a repeat.
The test then compares these measurements with the `tools/list` response, so a hint that disagrees with the store fails the test.

The D1 integration tests verify the receipt replay and the request conflicts on D1.
