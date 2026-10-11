# Coordinate issue ownership

This guide describes version 0.4.0 with schema 6 and snapshot 5.
Version 0.2.0 uses schema 5 and does not provide claim commands.
Check the installed `pd --help` or MCP tool schemas before using ownership operations.

Select the intended connection and actor before acquisition.
Use one lowercase session UUID for this caller session.
Keep it separate from each mutation's request UUID.
For CLI acquisition, pass `--session-id` or set `POLYLINEDB_SESSION_ID` for that run.
Without either, acquisition stops with a usage error.
The CLI does not generate a session UUID, because another process could not renew or release a claim under a UUID it never saw.
Repository and user defaults do not store session IDs.

## Acquire and inspect

Read the issue and the current store incarnation before acquiring:

```sh
pd show ISSUE_ID
pd claim acquire ISSUE_ID --incarnation OBSERVED_HEX --session-id SESSION_UUID \
  --agent-label Codex --request-id REQUEST_UUID
```

Replace the placeholders with the issue ID, the returned `claim.store_incarnation`, and retained lowercase UUIDs.
`show` returns the issue, its comments, and `claim`, the same inspection that `claim show` returns.
Acquire returns `claim_receipt` with the owner, session, generation, revision, deadline, and acquisition label.
It also returns `open_blockers`, the ids of active blockers, in issue order, as observed in that acquisition.
The list is empty when the issue has no blockers or only closed blockers.
A deferred blocker is included.
Acquire does not fail because active blockers remain, so a lock issue stays acquirable.
A replay of the same request reads `open_blockers` again, because the stored receipt does not keep the observation.
When the list is non-empty and the claim was meant to start work, release the claim immediately and pick another issue from the ready worklist.
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

`pd --claim-proof` accepts the four-field proof below, or a `claim_receipt` from acquire or renew.
The CLI reads `issue_id`, `incarnation`, `session_id`, and `generation` and ignores every other receipt field.
HTTP and MCP still require the four-field object.

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
Renewal and release of an active lease increase revision only.
By default, release of an expired lease returns `claim_conflict` with the current inspection, as it did before this option existed.
A release request can opt in with `expired_noop: true`. `pd claim release` always sends it.
With the option, release of an expired lease succeeds when the proof names that lease's session and generation and the caller is that lease's actor.
The result is `released: false` and the current inspection, whose `state` is `expired`.
The revision stays the same, `released_at` stays null, and the store writes no receipt.
A stale `expected_revision` still succeeds, because the release writes nothing.
Retry that cleanup with a new request UUID. The store reads the lease again.
Release of an active lease returns its receipt with or without the option.
Renewal still requires an unexpired proof.
A proof that names a different session or generation returns `claim_conflict` and leaves the revision unchanged, with or without the option, including when that newer lease is also expired.
A Worker released before the option rejects the field with `invalid_input`. The cloud client then sends the release once more without it. An older Worker answers `claim_conflict` for an expired lease. A Worker that answers the no-op for that plain release is decoded as `released: false`.
A status write under an expired lease still requires a new acquisition.
Closed issues remain claimable for reopening.
Release followed by acquisition provides explicit handoff.

The [change feed](operations.md#change-feed) records `claim_acquired` and `claim_released` for committed receipts.
Renewal, a replayed request, and a lease that passes its deadline record no event, so read `claim_show` for the current deadline.

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

## Keep a claim through long checks

A required check can outlast the 3600 second maximum TTL, and a process that waits on a background command has no turn in which to renew.
`pd claim keepalive` renews the lease for as long as a command or process runs, using only `claim_show` and `claim_renew`:

```sh
pd claim keepalive --claim-proof "$PROOF_JSON" --ttl 600 -- sh -c 'npm test && npm run test:d1 && npm run test:package'
pd claim keepalive --claim-proof "$PROOF_JSON" --ttl 600 --pid 12345
```

It renews at once, then one third of the TTL before each deadline on the database clock.
A renewal conflict from the same session is reread and retried; three failures in a row stop it with the store error.
It stops in these cases:

- The command or process exits. The exit code is the command's code, or 0 for `--pid`.
- The claim is released. The exit code is 0.
- The claim is lost: expired, taken by a new generation, invalidated, or held by another actor. The exit code is 5 and stderr carries `claim_lost`.
- `--max-duration` seconds pass. The default is 7200 and the maximum is 28800. The exit code is 6 and stderr carries `keepalive_max_duration`; the lease then ends at its last deadline.

The command keeps running in the last two cases unless you pass `--kill-on-loss`, which sends it SIGTERM.
The helper refuses an issue labeled `main-lock`, so lock claims stay short.
It renews as the actor of the CLI connection, which must be the claim's actor.

Cloud agents must not log the CLI in with the owner's OAuth, because that would be a different actor and a borrowed identity.
A cloud agent renews with the MCP `claim_renew` tool between long steps, reading `claim_show` for the revision, and runs long checks as separate commands.
Use keepalive on hosts that hold their own CLI credentials.

## Gate agent work

An actor has a kind, `human` or `agent`.
Local commands read the kind from `--actor-kind` or `POLYLINEDB_ACTOR_KIND`, and the kind defaults to `human`.
Repository defaults do not store the kind, because each agent host sets its own value.
Cloud connections derive the actor from authentication and take its kind from the role in the Worker roster; see [give each actor a role](cloud.md#give-each-actor-a-role).
They reject `--actor-kind` and ignore `POLYLINEDB_ACTOR_KIND`.

An agent claims only an issue with the `ready` label.
A different issue returns `not_ready`.
An agent reads the ready worklist only through the `ready` label, so `pd ready` shows an agent only labeled issues.
The ready worklist leaves out owner waits (`owner-decision`, `owner-action`) for every actor; see [owner waits](prerequisites.md#owner-waits). The claim gate itself checks only the `ready` label.

An agent needs its own active claim before it changes an issue.
The rule covers `update`, `close`, `reopen`, `comment`, and prerequisite edits where the issue is the dependent.
Without that claim, the write fails with `claim_required` and changes nothing.
When the agent's own lease has expired, that error says `The agent's own claim expired`, and `details.claim` reports `state`, `generation`, and `expires_at` next to `id`.
The store checks the claim and the `ready` label inside the same transaction as the write, so a release, an expiry, or a label removal just before the write cannot let it land.
Reads, claim commands, `actor`, issue creation, and memory commands stay open to agents.

A human keeps the cooperative contract and can claim an issue without the `ready` label.
To rewrite a `ready` issue, a human claims it first or removes the `ready` label, so that no agent picks it up during the edit.
The agent label in a claim is display text; the actor identifies the holder.

## Publish under the main-lock

Agents do not use this section.
They enqueue finished commits on the `queue` branch, leave the issue open with the `main-wait` label, and release the claim.
They do not acquire the main-lock, and they do not push main.

The owner uses this section to land `queue` onto main.
Every landing also adds one entry to the agent changelog `CHANGELOG.md` and one to `CHANGELOG.human.md`, in one commit on top of the landed commits, as the polylinedb-queue skill describes.

Each repository has one lock issue with the labels `main-lock` and `ready`, for example with the body `main-lock: OWNER/REPO`.
A human creates it once. Find it with `pd list --label main-lock`; the ready worklist never shows it.

Before a push to main, acquire the lock issue with a short TTL:

```sh
pd claim acquire LOCK_ID --incarnation OBSERVED_HEX --session-id SESSION_UUID \
  --ttl 120 --request-id REQUEST_UUID
```

While one actor holds it, another acquisition returns `claim_conflict`.
After the push, write the verified tip on the claimed work issue, then release the lock:

```sh
pd comment ISSUE_ID --body "tip: FULL_40_CHARACTER_SHA"
pd claim release --claim-proof "$LOCK_PROOF_JSON" --expected-revision LOCK_REVISION --request-id RELEASE_UUID
```

The newest `tip:` comment from the claim holder is the pointer for that issue.
The comment holds only the SHA line, with no reasoning and no tool output.
The owner then closes the work issue with its own proof and releases its claim.
Close comes first, because close requires the current proof.
