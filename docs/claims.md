# Coordinate issue ownership

This guide describes the unreleased source with schema 6 and snapshot 5.
Published version 0.2.0 uses schema 5 and does not provide claim commands.
Check the installed `pd --help` or MCP tool schemas before using ownership operations.

Select the intended connection and actor before acquisition.
Use one lowercase session UUID for this caller session.
Keep it separate from each mutation's request UUID.
For CLI acquisition, pass `--session-id` or set `POLYLINEDB_SESSION_ID` for that run.
Repository and user defaults do not store session IDs.

## Acquire and inspect

Read the current store incarnation before acquiring:

```sh
pd claim show ISSUE_ID
pd claim acquire ISSUE_ID --incarnation OBSERVED_HEX --session-id SESSION_UUID \
  --agent-label Codex --request-id REQUEST_UUID
```

Replace the placeholders with the issue ID, returned `store_incarnation`, and retained lowercase UUIDs.
Acquire returns `claim_receipt` with the owner, session, generation, revision, deadline, and acquisition label.
It leaves the issue status unchanged and can claim a closed issue.
Concurrent acquisitions elect one winner.
An already active claim rejects a fresh acquisition, including one from the same session.

`claim show` returns `claim` with `state`, `lease`, `store_incarnation`, and `observed_at`.
States are `never_claimed`, `active`, `released`, `expired`, and `invalidated`.
The lease retains the last owner and label after release or expiry.
An invalidated lease belongs to another store incarnation.
The observation describes database permission and stored history; it does not certify agent liveness.

```sh
pd claim list --project PROJECT --tool TOOL --limit 50
pd claim list --project PROJECT --after LAST_ID --limit 50
```

Lists include never-claimed issues, use numeric issue order, and return `next_cursor`.
Ready and blocked lists observe prerequisites and do not acquire claims.

## Change status with a proof

Copy exactly four fields from the receipt into a proof object:

```json
{
  "issue_id": "ISSUE_ID",
  "incarnation": "OBSERVED_HEX",
  "session_id": "SESSION_UUID",
  "generation": 1
}
```

The example uses placeholders; use the actual receipt generation instead of assuming `1`.
Retain this JSON as `PROOF_JSON` in the following commands.
Read the issue's field versions separately:

```sh
pd show ISSUE_ID
pd update ISSUE_ID --status in_progress --expect status=STATUS_VERSION --claim-proof "$PROOF_JSON"
pd close ISSUE_ID --expected STATUS_VERSION --claim-proof "$PROOF_JSON"
pd reopen ISSUE_ID --expected STATUS_VERSION --claim-proof "$PROOF_JSON"
```

Each command uses the version observed before that command.
The database checks the authenticated actor, session, generation, issue, incarnation, and expiry in the same write as field CAS.
After acquisition has activated an issue's claim lifecycle, every requested status write requires an unexpired current proof.
This includes unchanged status values and multifield updates.
Release or expiry requires a new acquisition before another status write.

An explicitly supplied proof also guards body-only updates.
Without a proof, other field edits retain their existing CAS contract, and comments remain cooperative.
The prerequisite `--force --reason` option never bypasses ownership.
No-op status changes still advance their field version when accepted.

## Renew, release, and retry

Read the current claim revision before a new renewal or release:

```sh
pd claim show ISSUE_ID
pd claim renew --claim-proof "$PROOF_JSON" --expected-revision CLAIM_REVISION \
  --ttl 300 --request-id RENEW_REQUEST_UUID
pd claim release --claim-proof "$PROOF_JSON" --expected-revision CLAIM_REVISION \
  --request-id RELEASE_REQUEST_UUID
```

TTL defaults to 300 seconds and accepts integers from 30 through 3600.
The database clock determines the deadline; equality means expiry.
Claim timestamps are safe integer Unix seconds, including acquisition, last change, expiry, release, and inspection.
The nullable acquisition label contains at most 64 UTF-8 bytes and grants no authority.

A new acquisition increases generation and revision.
Renewal and release increase revision only.
Closed issues remain claimable for reopening.
Release followed by acquisition provides explicit handoff.

After an uncertain result, retry only with the original request UUID and identical actor, session, incarnation, and payload.
A committed request returns its original immutable receipt after later renewal, release, reacquisition, or restore.
That receipt is history; inspect the current claim before more work.
Rejected fresh mutations retain no receipt.
The CLI does not automatically retry, refresh revisions, or reacquire.

Portable restore rotates destination authority and preserves source claim records as invalidated history.
A missing old receipt with an old incarnation cannot acquire in the restored store.
Observe the current incarnation and choose a new request UUID for a deliberate new acquisition.
An arbitrary raw copy with an unchanged incarnation requires explicit offline rotation before use.
See [D1 restoration](d1-migration.md) and [ownership design](adr/0009-issue-ownership.md).
