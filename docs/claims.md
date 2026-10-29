# Coordinate issue ownership

This guide describes the current source with schema 12 and snapshot 10.
Version 0.6.0 uses schema 10 and snapshot 8.
Versions 0.5.0 through 0.5.2 use schema 8 and snapshot 6.
Versions 0.3.0 and 0.4.0 use schema 6 and snapshot 5.
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
Acquire also returns `open_asks`, the [asks](#ask-a-person-and-check-the-result) on the issue that wait for an answer, each with `n`, `text`, `options`, and `recommended`, in the order they were asked.
Like `open_blockers`, it is an observation that does not refuse the acquisition, and a replay reads it again.
A non-empty list means a person still has to answer before the work it asks about can go on.
Acquire also returns `previous_lease`. It is the lease that expired without a release just before this acquisition, with its actor, session, label, generation, and deadline, or `null` after a release, a first acquisition, or a lease from another store incarnation.
The value comes from the immutable receipt history, so a replay returns the same `previous_lease`.
A non-null `previous_lease` means the previous holder may still be running. Read the issue comments and any pushed `work/<issue id>` branch before starting.
The `claim.run` that `show` or `claim show` returned before the acquisition carries that holder's last report.
A holder that cannot renew in time pushes its work branch, comments with what remains, sets status `open` with its proof, and releases the claim instead of letting the lease lapse.
It leaves the issue status unchanged and can claim a closed issue.
Concurrent acquisitions elect one winner.
An already active claim rejects a fresh acquisition, including one from the same session.

`claim show` returns `claim` with `state`, `lease`, `store_incarnation`, and `observed_at`, and `run` when a lease exists; see [report what you are doing](#report-what-you-are-doing).
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

Starting work requires a held claim.
A `status` or `type` change that leaves an issue other than an epic at `in_progress` requires a current proof.
The rule applies to every actor, the owner included, and to a never-claimed issue too.
It covers an unchanged `in_progress` value, a change from `deferred`, and a type change that turns an `in_progress` epic into another type.
The type after the update decides, so one update can set `in_progress` and `type: epic` without a proof.
Without a proof, the write fails with `claim_required` and changes nothing.
An epic can be `in_progress` without a claim.
`create` refuses `status: in_progress` for a type other than `epic` with `invalid_input`, because no claim exists yet.
Create the issue `open`, acquire a claim, and then set `in_progress` with the proof.
Release and expiry leave the status unchanged, and reads never fail because of it.
To find such issues, run `pd list --status in_progress --claimed false`, or call `list` with `claimed: false`.
`pd show --human` prints `in_progress (no active claim)` for an issue other than an epic in that state, and `/ui/stuck` lists them under **Started, no live claim**.
Before a release without `claim_handoff`, set status `open` with the proof.

An explicitly supplied proof also guards body-only updates.
Without a proof, other field edits retain their existing CAS contract, and comments remain cooperative.
A body, priority, or label edit of an `in_progress` issue needs no proof.
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

## Report what you are doing

A holder reports one line about its work with `claim_report`:

```sh
pd claim report --claim-proof "$PROOF_JSON" --kind error \
  --text 'wrangler d1 execute fails: no such table comments_v2' --request-id REPORT_REQUEST_UUID
```

`kind` is `working`, `blocked`, `error`, or `done`. `text` is one line of at most 200 UTF-8 bytes.
A report needs the unexpired proof and no `expected_revision`, so it never conflicts with a keepalive renewal in the same session.
The newest report replaces the one before it, and a report adds no comment.
A report writes a receipt with outcome `renewed` that increases the revision and keeps `expires_at`. It never extends or shortens the lease, so renew separately.
A renewal or release that read the revision before a report gets `claim_conflict` and reads again, as keepalive already does.
A retry with the same request UUID and payload returns the original receipt. A report under an expired, released, or foreign proof returns `claim_conflict` with the current inspection.
The change feed records no event for a report.

`claim show`, `show`, and `claim list` return `run` for every lease: `{ state, quiet_after, last }`.
`last` is the newest report, `{ kind, text, at }`, or `null`. `at` is the store clock in Unix seconds.

| Newest report | `run.state` |
| --- | --- |
| `working`, or none | `working`, then `quiet` after `quiet_after` (600) seconds with no report |
| `blocked` | `waiting` |
| `error` | `errored` |
| `done` | `finishing` |

Only `working` turns `quiet` with time. A lease with no report counts from its acquisition.
Keepalive renewals carry no report, so a holder whose keepalive runs but who says nothing becomes `quiet` while the lease stays live.
A lease that ended keeps the run it had at its deadline or its release, so an `error` stays visible after the lease expires.
A `claim_conflict` inspection and the `released: false` answer carry no `run`.

`/ui/stuck` lists live claims whose run is `quiet` or `errored` under **Live claim, quiet or errored**.
Under **Claim expired** it lists expired leases on started issues, and expired leases whose last report was `error` on any issue that is not closed.
The Stuck badge counts both.

Report `blocked` or `error` as soon as you stop, and `done` just before a handoff.

## Hand off to the landing queue

`claim_handoff` ends a lane's work on an issue in one write.
Under the caller's proof and the current claim revision, it adds a `tip: <sha>` comment and an optional summary comment, sets status `open`, removes `ready`, adds `main-wait`, keeps the other labels, and releases the claim.
It reads the issue first and commits only while the status and label versions it read still hold; when only those moved, it reads again and retries twice at most.
It refuses a closed issue with `conflict`, a proof that no longer holds with `claim_conflict`, and an issue with an open ask or an unmet check with [`items_open`](#close-and-handoff-wait-for-the-items), and writes nothing in any of these cases.
The release receipt is the idempotency record: it stores the handoff request as its payload, and the comment IDs come from the request UUID.
A retry with the same request UUID and arguments returns the same receipt and comments and writes nothing. Different arguments, or a `claim_release` with that UUID, return `claim_request_conflict`.
The last statement of the batch checks that both comments and the queue labels are present, so a write that a trigger or constraint drops aborts the whole batch.
The change feed records `claim_released`, one `commented` per comment, and `status_changed` or `updated` when the issue moved.
`pd claim handoff --claim-proof JSON --expected-revision N --tip SHA [--summary TEXT | --summary-file PATH]` sends it. No schema change was needed.
Renewal, a replayed request, and a lease that passes its deadline record no event, so read `claim_show` for the current deadline.

After the handoff commits, the result adds `land_order_warnings: [{id, status}]`.
Each entry is an issue that the handed-off issue [lands after](prerequisites.md#land-order) and that is neither closed nor labeled `main-wait`, so it has not reached the queue yet.
Only direct predecessors count. The list is read after the commit, so it is advisory: report it, and do not reorder or undo the push.

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

## Ask a person and check the result

An issue can carry items. An item is an ask or a check, numbered `n` from 1 on its issue in the order it was added.
Items are never deleted, and each one leaves `open` once.

An ask is a question for a person.
It has its text, optional `options` (2 to 8 distinct answers), and an optional `recommended` option.
It ends `answered`, with the answer and an optional note, or `withdrawn`, with a reason.
An answer to an ask with options must be one of them; an ask without options takes free text.
A check is an acceptance condition that has to hold before the issue closes.
It ends `met`, with a short evidence line, or `waived`, with a reason.

```sh
pd item ask pd-12 'Store dates as bare dates or timestamps?' --option 'bare date' --option timestamp --recommended 'bare date'
pd item check pd-12 'npm test passes on Node 24'
pd item answer pd-12 1 'bare date' --note 'keep it simple'
pd item meet pd-12 2 'npm test: 662 pass, 0 fail'
pd item waive pd-12 2 'covered by CI on this branch'
pd item withdraw pd-12 1 'the spec now says bare dates'
```

MCP has two tools. `item_add` takes `id`, `kind` (`ask` or `check`), `text`, optional `options` and `recommended`, and a `request_id`.
`item_resolve` takes `id`, `n`, `to` (`answered`, `withdrawn`, `met`, or `waived`), `answer` for an answer, and `note`.
`show` returns the issue's `items`. Both writes return `{ id, item, items }`, and `item_add` also returns `wait_from`.

### Who may end an item

| Move | Who | Note |
| --- | --- | --- |
| Add an ask or a check | Anyone who may write the issue. An agent needs its own active claim. | The issue must not be closed. |
| Answer an ask | A human actor that did not ask it, or a person on the `/ui` issue page | Optional. |
| Withdraw an ask | The actor that asked it, or a human | Required. An agent needs its claim. |
| Meet a check | Anyone who may write the issue. An agent needs its own active claim. | Required: the evidence. |
| Waive a check | A human actor | Required: the reason. |

A refused move is `item_actor_refused` (403) and writes nothing.
Repeating the move that ended an item, with the same answer or note, returns the item unchanged. A different move or answer after it is `item_conflict` (409), with the item as it stands in `details.item`.

The store checks the actor kind it is given, and that kind is only as honest as its source.
On a local store the kind is self-declared by `--actor-kind` or `POLYLINEDB_ACTOR_KIND`, so a process that declares itself human can answer an ask that another actor raised.
On the cloud store the kind comes from the roster role, and an agent host that signs in through OAuth as the owner acts as the owner's human actor.
That is why the asking actor cannot answer its own ask through MCP, HTTP, or the CLI: every host that shares the owner's sign-in shares the actor that asked.
The `/ui` issue page and the You lane answer as the signed-in person even when that person's actor asked, because the page is the one write path such a host does not reach through its tools.
Anything that holds the owner's browser session or a token for the owner can still answer as the owner. The store cannot tell that apart from the owner.

### Wait for the answer

An open ask takes the issue off the ready worklist for every actor and lists it in [owner waits](prerequisites.md#owner-waits), in the `/ui` You lane, and on the Attention list.
The asking agent keeps its claim, says it is blocked with `claim_report`, and waits for the answer in the change feed:

```sh
pd claim report --claim-proof "$PROOF" --kind blocked --text 'waiting on ask 1'
pd wait --since WAIT_FROM_SINCE --issue pd-12 --kind answered
```

`item_add` returns `wait_from: { incarnation, since }`, the feed position just after the ask, so the wait cannot miss an answer that lands first.
The ask records `asked` and the answer records `answered`, so a wait filtered to `answered` never wakes on its own question.
When the last open ask leaves an open issue that has no active blocker, the store records `became_ready` after the answer.
Other item moves record `updated` with `fields: ["items"]`.
Keep the lease alive while waiting with `claim keepalive`, or with `claim_renew` between waits.
After the wake, read the answer with `show`.

### Close and handoff wait for the items

`close` and `claim_handoff` refuse with `items_open` (409) while an ask is open or a check is unmet, and write nothing.
The message names every such item with the command that ends it, and `details` carries `{ id, open_items: [{ n, kind, text }] }`.
`close --force --reason TEXT` bypasses the items the way it bypasses prerequisites, and saves the reason as a comment.
`claim_handoff` has no force: meet or waive each check, and wait for each ask to be answered or withdraw it, before the handoff.

## Verify a resource deletion

`resource_update` with `mark: "verified_deleted"` requires a current claim proof on the issue from every actor, the owner and humans included, and fails with `claim_required` without one.
Verification ends the cleanup obligation that a [resource entry](operations.md#external-resources) records, so it needs the same proof as the other writes that end work on an issue.
The other resource writes follow the agent gate: an agent needs its own active claim, and a human does not.

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
While a keepalive holds the lease, report progress with `claim_report`, which needs no revision.
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
The ready worklist leaves out owner waits (an open ask, `owner-decision`, `owner-action`) for every actor; see [owner waits](prerequisites.md#owner-waits). The claim gate itself checks only the `ready` label.
An agent that needs a person's answer adds an ask instead of an owner label: the ask holds the question and its options, and the answer reaches the agent through the change feed.

An agent needs its own active claim before it changes an issue.
The rule covers `update`, `close`, `reopen`, `comment`, `comment_edit`, `item_add`, `item_resolve`, and prerequisite edits where the issue is the dependent.
Without that claim, the write fails with `claim_required` and changes nothing.
When the agent's own lease has expired, that error says `The agent's own claim expired`, and `details.claim` reports `state`, `generation`, and `expires_at` next to `id`.
The store checks the claim and the `ready` label inside the same transaction as the write, so a release, an expiry, or a label removal just before the write cannot let it land.
Reads, claim commands, `actor`, issue creation, memory commands, `star`, and `unstar` stay open to agents.
A star changes no issue field, so it needs no claim; see [posts and stars](operations.md#posts-and-stars). A `reader` actor still cannot star, because a star is a write.
A post, a comment with a handle, is a `comment`, so it needs the claim. The handle grants nothing.

A human keeps the cooperative contract and can claim an issue without the `ready` label.
To rewrite a `ready` issue, a human claims it first or removes the `ready` label, so that no agent picks it up during the edit.
The agent label in a claim is display text; the actor identifies the holder.

## Publish under the main-lock

Agents do not use this section.
They enqueue finished commits on the `queue` branch, leave the issue open with the `main-wait` label, and release the claim.
They do not acquire the main-lock, and they do not push main.

The owner, or rocky with the owner's standing permission, uses this section to land `queue` onto main, once Check is green on the queue tip.
A landing adds no commit. The changelog entries are already in the work commits, as the polylinedb-queue skill describes.
Neither changelog names pd issue ids, because readers cannot open pd. Each entry describes the change in words.

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
