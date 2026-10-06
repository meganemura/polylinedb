# Issue ownership leases

An issue claim gives one cooperating session permission to change an issue status until a database deadline.
The authenticated actor identifies the caller, and a caller-retained UUID distinguishes sessions that share that actor.
The session UUID does not authenticate a caller or protect files, Git operations, or other external effects.

Claims use separate `issue_claims` and `claim_requests` tables.
The seven ordinary issue fields retain their field versions and response shapes.
An acquisition does not change the issue status, and closed issues remain claimable so a new owner can reopen them.

The caller supplies the observed store incarnation when acquiring a claim.
The database accepts acquisition only when that incarnation matches the current singleton and the issue has no active claim.
Every acquisition increases generation and revision, including acquisition after release, expiry, or incarnation rotation.
Renewal and release increase revision and require the observed revision and a current ownership proof.

The proof contains the issue ID, store incarnation, session UUID, and generation.
The database compares the proof with the current claim, current store incarnation, and actor at the write.
All requested status changes require a proof after the claim lifecycle starts, including equal-value writes and multifield updates.
An explicitly supplied proof also guards edits to other fields.
Proofless edits to other fields and comments retain their cooperative contracts.
The prerequisite force option does not bypass ownership.

The database clock determines acquisition and expiry.
TTL defaults to 300 seconds and accepts integers from 30 through 3600.
Equality with the deadline means the claim has expired.
Timestamps use Unix seconds for acquisition, the last claim change, expiry, release, and inspection.
Inspection describes stored history and permission at that timestamp, rather than agent liveness.
A nullable caller label contains at most 64 UTF-8 bytes and grants no authority.

A successful mutation inserts an immutable receipt before it applies the claim transition in the same batch.
A copied existing receipt forces a duplicate primary-key failure before fresh admission predicates can run.
After rollback, the executor compares the actor and normalized request payload before returning the original result.
Rejected fresh mutations insert no receipt.
A final database constraint aborts the batch when an admitted receipt does not match the resulting aggregate.

Retries retain the request UUID, session, incarnation, and payload.
An original receipt remains historical evidence after later changes or incarnation rotation.
A missing old receipt with an old incarnation cannot acquire in the restored store.
The caller must explicitly observe the new incarnation and choose a new request UUID for a new acquisition.

Generation and revision remain monotonic along uninterrupted store history.
A backup rollback can restore smaller counters, so incarnation remains part of every proof.
Restoration and transfer must preserve receipt history and invalidate imported authority through a distinct destination incarnation.
Raw copies that retain the same incarnation require explicit offline rotation before use.
