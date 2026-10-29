# Operation contract

The CLI, HTTP endpoint, and MCP tools share validation and mutation rules.
HTTP accepts JSON at `POST /v1/operations`.
The operation name is the `op` property.
MCP uses that name as the tool name and omits `op` from its arguments.
The local `init` command creates storage; cloud schema installation is an operator action.

## Server version

The authenticated Worker exposes `GET /v1/version` and the MCP tool `server_info`.
The tool accepts no arguments. Both return the same fields.

| Field | Meaning |
| --- | --- |
| `package_version` | Version from the package manifest used to build the Worker |
| `git_commit` | Full commit SHA from a clean source checkout at build time, or `null` when unknown |
| `schema_version` | Version read from the connected database's `schema_version` table |

Readers, human actors, and agent actors can read this information without a claim.
The read changes no records. Responses use `Cache-Control: no-store`.
MCP rejects extra arguments with `invalid_input`. HTTP accepts only `GET`.
The local CLI has no `server_info` operation because its storage has no Worker build identity.
Read `server_info` before you assume that a deployed server supports an operation or schema.
Unknown build provenance does not mean that the Worker matches the current checkout.

## Fields

| Field | Meaning and constraints | Create default |
| --- | --- | --- |
| `id` | Prefix plus positive integer; children append numeric suffixes, up to eight numeric segments | Generated |
| `tool` | Tool or component the issue concerns; nonempty, at most 256 UTF-8 bytes | Required |
| `project` | Project name, nonempty, at most 256 UTF-8 bytes | Required |
| `body` | Issue content, nonempty, at most 65536 UTF-8 bytes | Required |
| `status` | `open`, `in_progress`, `deferred`, `closed` | `open` |
| `type` | `bug`, `task`, `epic`, `feature`, `chore` | `task` |
| `priority` | Integer 0 through 4, with 0 the highest priority | `2` |
| `labels` | At most 64 names; duplicates removed and names sorted | `[]` |

Names exclude control characters.
Bodies exclude NUL and whitespace-only content.
Each label follows the same rules as a tool name.
An issue also contains `versions`, `created_at`, `created_by`, `updated_at`, and `updated_by`.
Local results and MCP add `closed_at` and `closed_by`: the time and actor of the transition into `closed`.
Both are null while the issue is not closed, and for an issue closed before schema 8.
Closing an issue that is already closed keeps the first closure.
Reopen and any other status change away from `closed` clear them, and other edits keep them.
`/v1/operations` responses omit both fields by default, so released cloud clients keep reading the same issue shape.
A request with the header `polylinedb-issue-fields: closure` keeps both fields on every issue in its success or error body.
The cloud CLI sends that header from this release on and accepts an issue with both fields or with neither, because an older Worker ignores the header.
It rejects an issue with only one of them, or with a closure on an issue that is not closed, as `cloud_invalid_response`.
Timestamps use UTC ISO strings.

Use `tool` for the affected tool or component, such as `compiler`, `editor`, or `polylinedb`.
Use `project` for the project context in which the issue applies.
The actor identifies who performs an operation and supplies the audit authors.
For example, an agent can report an `editor` issue in project `parser` with actor `local:agent`.
An agent's name is not the affected tool merely because that agent created the issue.

## Requests and results

| Operation | Arguments besides `op` | Result |
| --- | --- | --- |
| `create` | Required `tool`, `project`, `body`, `prefix`, `request_id`; optional mutable fields and `parent` | `{ "issue": ... }` |
| `show` | `id`; optional `with_land_order: true` | `{ "issue": ..., "comments": [...], "items": [...] }`; with `with_land_order`, also `"land_order": ...` |
| `list` | Optional filters; optional `with_land_order: true` | `{ "issues": [...], "next_cursor": ... }`; with `with_land_order`, also `"land_order": [...]`, one entry per issue in the same order |
| `search` | `query`, optional filters, optional `with_matches: true` | Same as list; with `with_matches`, also `"matches": [...]` |
| `comment` | `id`, `body`; optional `handle`, `via`, `reply_to` | `{ "comment": ... }` |
| `comment_edit` | `id`, `comment_id`, `body`, `expected` comment version | `{ "comment": ... }` |
| `star`, `unstar` | `id`, `comment_id`; optional `handle` | `{ "star": ..., "outcome": ... }` |
| `post` | `project`, `body`, `handle`; optional `via`, `reply_to` | `{ "comment": ... }` |
| `posts` | optional `project`, `handle`, `min_stars`, `since`, `after`, `limit` | `{ "posts": [...], "next_cursor": ... }` |
| `update` | `id`, nonempty `changes` array | `{ "issue": ... }` |
| `close` | `id`, `expected` status version; optional `resources_reason` | `{ "issue": ... }`; `items_open` while an ask is open or a check is unmet, unless `force` |
| `item_add` | `id`, `kind` (`ask` or `check`), `text` (at most 4096 UTF-8 bytes), `request_id`; optional `options` (2 to 8 distinct, each at most 200 UTF-8 bytes) and `recommended` for an ask | `{ "id": ..., "item": ..., "items": [...], "wait_from": { "incarnation": ..., "since": ... } }` |
| `item_resolve` | `id`, `n`, `to` (`answered`, `withdrawn`, `met`, or `waived`); `answer` with `answered`; `note` (required except with `answered`) | `{ "id": ..., "item": ..., "items": [...] }` |
| `reopen` | `id`, `expected` status version | `{ "issue": ... }` |
| `actor` | None | `{ "actor": ... }` |
| `dependency_list` | `dependent_id`; optional `after`, `limit` | `{ "dependent_id": ..., "revision": ..., "blockers": [...], "next_cursor": ... }` |
| `dependency_add`, `dependency_remove` | `dependent_id`, `blocker_id`, `expected_revision`, `request_id` | `{ "dependency": { "dependent_id": ..., "blocker_id": ..., "revision": ..., "outcome": ... } }` |
| `dependency_worklist` | `state: "ready"` or `"blocked"`; optional issue filters except `status` | Same as list |
| `land_order_list` | `issue_id` | `{ "issue_id": ..., "revision": ..., "after": [...], "before": [...] }` |
| `land_order_add`, `land_order_remove` | `later_id`, `earlier_id`, `expected_revision`, `request_id` | `{ "land_order_receipt": { "later_id": ..., "earlier_id": ..., "revision": ..., "outcome": ... } }` |
| `resource_list` | `issue_id` | `{ "issue_id": ..., "revision": ..., "resources": [...] }` |
| `resource_live` | Optional `tool`, `project`, `after`, `limit` | `{ "entries": [{ "issue": { "id": ..., "project": ..., "status": ... }, "resources": [...] }], "next_cursor": ... }` |
| `resource_add` | `issue_id`, `kind`, `name`, `expected_revision`, `request_id` | `{ "resource_receipt": { "issue_id": ..., "seq": ..., "revision": ..., "outcome": "added" } }` |
| `resource_update` | `issue_id`, `seq`, `expected_revision`, `request_id`, and `external_id`, `mark`, or both; `evidence` and `claim_proof` with `mark: "verified_deleted"` | `{ "resource_receipt": { "issue_id": ..., "seq": ..., "revision": ..., "outcome": "updated" } }` |
| `dependency_owner_waits` | Optional `tool`, `project`, `after`, `limit` | `{ "waits": [{ "issue": ..., "dependents": [...], "dependents_next": ... }], "next_cursor": ... }` |
| `claim_show` | `issue_id` | `{ "claim": ... }` |
| `claim_list` | Optional `tool`, `project`, `after`, `limit` | `{ "claims": [...], "next_cursor": ... }` |
| `claim_acquire` | `issue_id`, observed `incarnation`, `session_id`, `request_id`; optional `ttl`, nullable `agent_label` | `{ "claim_receipt": ..., "open_blockers": [...], "open_asks": [...] }` |
| `claim_renew` | `claim_proof`, `expected_revision`, `request_id`; optional `ttl` | `{ "claim_receipt": ... }` |
| `claim_report` | `claim_proof`, `kind` (`working`, `blocked`, `error`, or `done`), `text` (at most 200 UTF-8 bytes), `request_id` | `{ "claim_receipt": ... }` with outcome `renewed` and the unchanged `expires_at` |
| `claim_handoff` | `claim_proof`, `expected_revision`, `request_id`, `tip` (7 to 40 lowercase hex digits); optional `summary` (at most 65536 UTF-8 bytes) | `{ "claim_receipt": ..., "handoff": { "issue": ..., "comments": [...] }, "land_order_warnings": [{ "id": ..., "status": ... }] }` |
| `claim_release` | `claim_proof`, `expected_revision`, `request_id`; optional `expired_noop: true` | `{ "claim_receipt": ... }`; with `expired_noop` and the caller's expired lease, `{ "released": false, "current": ... }` |
| `changes` | `since`; `incarnation` when `since` is greater than 0; optional `project`, `issue_ids`, `kinds`, `limit` | `{ "incarnation": ..., "changes": [...], "next_since": ... }` |

Unknown arguments are rejected.
The cloud actor comes from authentication, so requests cannot supply an actor.
`parent` must name an existing epic.
The parent relationship is immutable; an epic with children cannot change to another type.
Prerequisites form a separate acyclic graph. They can cross projects within the selected store.
See [issue prerequisites](prerequisites.md) for aggregate conflicts, immutable request receipts, and readiness semantics.
[External resources](#external-resources) record what work on an issue created outside the store, and keep the issue from closing until each one is verified deleted.
[Land order](prerequisites.md#land-order) says which issue should reach main first. It never blocks work, shares the cycle check with prerequisites, and has its own revision and receipts.
Close and updates that request `in_progress` or `closed` accept `force: true` with a nonempty `reason` for an explicit exception.
The reason becomes an attributed comment in the successful status transaction. Ordinary operation results retain their existing shapes.
Schema 7 adds the [change feed](#change-feed) and keeps every operation result unchanged.
Schema 8 adds `closed_at` and `closed_by` to issues in local results and MCP.
Schema 9 adds land order, external resources, and the optional change feed field `relation`; default results keep their shapes.
Schema 10 adds [comment edits](#comment-edits). Every comment in a result has `version`, `updated_at`, and `updated_by`.
Schema 11 adds [posts and stars](#posts-and-stars). Every comment in a result has `handle`, `via`, and `reply_to`, and every comment in `show` also has `stars` and `starrers`.
Version 0.3.0 uses schema 6 and adds issue ownership while retaining all seven ordinary issue fields.
Version 0.2.0 uses schema 5.
`update`, `close`, and `reopen` accept optional `claim_proof` with `issue_id`, `incarnation`, `session_id`, and `generation`.
The CLI `--claim-proof` flag accepts that object or a `claim_receipt` and sends only those four fields.
Once acquisition activates an issue, every requested status change requires a current unexpired proof at the write.
A `status` or `type` change that leaves an issue other than an epic at `in_progress` requires a current proof on every issue, claimed or not, and otherwise fails with `claim_required`.
`create` rejects `status: in_progress` for a type other than `epic` with `invalid_input`.
A supplied proof also guards other field changes, including after restore removes the claim row.
Proofless other-field edits and comments retain their existing cooperative contracts.
Force bypasses prerequisites only.
Claim timestamps use safe integer Unix seconds; the ordinary issue timestamps remain ISO strings.
See [ownership operations](claims.md) for inspection states, bounded TTL, session identity, and immutable retry behavior.

`prefix` has 1 through 16 lowercase ASCII letters or digits and starts with a letter.
Each store maintains a separate root counter per prefix and a child counter per parent ID.
Children must use their parent's prefix.
Numeric segments range from 1 through JavaScript's maximum safe integer.
Allocation at that limit fails with `counter_exhausted` and changes nothing.
Numbers are not padded or reused; `pd-99` is followed by `pd-100`.
The prefix is independent of the mutable project field.

`request_id` is a UUID required by HTTP and MCP create requests. The parser stores the lowercase form, so an uppercase UUID and its lowercase spelling are the same request ID.
The CLI accepts `--request-id` and generates one when omitted.
To retry across CLI invocations, specify the same request ID explicitly.
The same request ID, normalized creation arguments, and actor return the current state of the original issue.
A different payload or actor produces `request_conflict` with status 409.
Replay does not increment counters, update the issue, or reset later edits.
Request IDs are scoped to the store and retained with its data.

Filters are `tool`, `project`, `status`, `type`, `priority`, and one `label`.
`list` also accepts `claimed: true` or `claimed: false`; the CLI flag is `--claimed true|false`.
`claimed: true` keeps issues with an active claim. `claimed: false` keeps issues whose claim state is `never_claimed`, `released`, `expired`, or `invalidated`.
The database clock decides expiry at the read, as in `claim_show`.
Combine `status: "in_progress"` with `claimed: false` to find started work that nobody holds.
A Worker released before this filter rejects the field with `invalid_input`; the cloud client does not retry without it, because that page would answer a different question.
All supplied filters must match.
`limit` defaults to 50 and accepts 1 through 100.
Pass `next_cursor` as `after` to read another page; `null` means the page ends the current results.
Results are ordered by prefix, then by the numeric segments of each ID; a parent precedes its children.
Pagination does not preserve a snapshot across requests.
Search matches literal, case-sensitive substrings in bodies or comments.
`show` returns all comments, ordered by timestamp and ID.

## External resources

An entry records one thing that work on an issue creates outside the store, such as a preview database or a Worker.
Record it with `resource_add` before creating the resource, then move it forward with `resource_update`.

```sh
pd resource add demo-1 --kind d1:database --name preview-db --expected-revision 1
pd resource update demo-1 --seq 1 --external-id 0f3c2a --mark created --expected-revision 2
pd resource update demo-1 --seq 1 --mark deleted --expected-revision 3
pd resource update demo-1 --seq 1 --mark verified_deleted --evidence "d1 list no longer shows 0f3c2a" --claim-proof "$PROOF" --expected-revision 4
pd resource live --project demo
```

`kind` is free-form and matches `^[a-z0-9][a-z0-9:._-]{0,63}$`.
`name` and `external_id` are identifiers only: 1 to 256 UTF-8 bytes with no whitespace or control characters.
Never record a secret, a token, a connection string, or a URL with credentials in any resource field.
`evidence` is at most 1024 UTF-8 bytes. A value outside these rules fails with `invalid_input`.

Each entry has a `seq` from 1 within its issue and a `state` derived from its marks: `planned`, `created`, `deleted`, or `verified_deleted`.
Marks move forward only, from `planned` to `created` to `deleted` to `verified_deleted`, or from `planned` straight to `verified_deleted` for a resource that was never created.
Each mark is set once, with the store clock. `external_id` is set once.
A mark that does not move forward, a second `external_id`, or any change to a verified entry fails with `resource_mark_rejected`, with the entry in `details.resource`.
`verified_deleted` needs `evidence` and a current `claim_proof` on the issue from every actor; without a held proof it fails with `claim_required`.

The resource revision belongs to the issue and starts at 1, as for prerequisites.
A stale request fails with `resource_conflict`, with `expected_revision` and the current `resource_list` result in `details.current`.
A reused request UUID with another actor or payload fails with `resource_request_conflict`, and a retry returns the original receipt.
An agent writes resources only on an issue it holds a claim on.

An entry is live until `verified_deleted`.
While an issue has a live entry, `close` and an `update` that sets status `closed` fail with `resources_remaining` and no details.
The message names up to five live entries as `kind:name`. The CLI then reads `resource_list` and reports the live entries in `details.resources`.
A nonempty `resources_reason` closes anyway and is stored as a comment by the closing actor in the same write; `pd close --resources-reason TEXT` sends it.
`force` does not bypass this check. An epic answers only for its own entries.
`resource_live` lists the issues that still have live entries, in issue order, with those entries.



`search` finds literal, case-sensitive text in issue bodies and comments.
A request with `with_matches: true` also returns `matches`, which tells where each issue on the page matched.
A request without it returns only `issues` and `next_cursor`, so clients of version 0.3.1 and earlier still decode the result.
The CLI and the MCP `search` tool always request matches. The MCP tool does not take `with_matches` as an input.
A Worker that predates this field rejects it as an unexpected field.
The cloud client then sends the search once more without the field and returns that page without `matches`.

```json
{ "issues": [...], "next_cursor": null, "matches": [
  { "issue_id": "pd-3", "location": "body", "excerpt": "…the parser fails on empty input…" },
  { "issue_id": "pd-3", "location": "comment", "comment_id": "4f0c…", "excerpt": "empty input also fails in the editor" }
] }
```

`matches` follows the order of `issues`. For each issue, a body match comes first, then one entry for each matching comment in `show` order.
The excerpt surrounds the first match in that body or comment and is at most 160 UTF-8 bytes.
It keeps whole code points, replaces control characters such as line feeds with spaces, and marks removed text with `…` at either end.
When the query alone exceeds the bound, the excerpt shows the start of the match and ends with `…`.
Each page reads its matching comments in one additional query, whatever the page size.

## Change feed

`changes` returns the issue changes of the whole store in the order that they committed.
An event says that an issue changed. Read the issue again for its current state.
The [change feed decision](adr/0016-change-feed.md) records the design and its alternatives.

```json
{ "incarnation": "4be1…", "changes": [
  { "seq": 41, "incarnation": "4be1…", "issue_id": "pd-7", "kind": "updated", "fields": ["body", "priority"], "occurred_at": 1791590400, "actor": "local:codex" },
  { "seq": 42, "incarnation": "4be1…", "issue_id": "pd-9", "kind": "became_ready", "fields": [], "occurred_at": 1791590400, "actor": "local:codex" }
], "next_since": 42 }
```

| Field | Meaning |
| --- | --- |
| `seq` | Position in the store's sequence, from 1, without gaps or repeats within one incarnation |
| `incarnation` | The store incarnation, the same value as `claim.store_incarnation` |
| `issue_id` | The changed issue; for a prerequisite edit, the dependent; for a land-order edit, the later issue; for a star, the issue of the comment |
| `kind` | One of the kinds in the next table |
| `fields` | For `updated` and `status_changed`, the written field names in field order; `["resources"]` for a resource entry change; `["items"]` for a check added, or an item that leaves `open` other than by an answer; otherwise `[]` |
| `occurred_at` | Database time of the write, in integer Unix seconds |
| `actor` | The actor of the write |
| `relation` | Present only on `dependency_added` and `dependency_removed` for a land-order edit, with the value `lands_after`; a prerequisite edit has no `relation` |

| Kind | Recorded when |
| --- | --- |
| `created` | `create` inserts an issue |
| `updated` | `update` writes fields other than `status`, `resource_add` or `resource_update` commits an entry change, `item_add` adds a check, or `item_resolve` withdraws an ask, meets a check, or waives one |
| `asked` | `item_add` adds an ask; `fields` is `[]` |
| `answered` | `item_resolve` answers an ask; `fields` is `[]` |
| `status_changed` | `update`, `close`, or `reopen` writes `status`; `fields` includes `status` |
| `commented` | `comment` appends a comment, or a forced status change appends its reason |
| `comment_edited` | `comment_edit` replaces the body of a comment; `fields` is `[]` |
| `starred` | `star` adds a star; `fields` is `[]` |
| `unstarred` | `unstar` removes a star; `fields` is `[]` |
| `claim_acquired` | `claim_acquire` commits a receipt |
| `claim_released` | `claim_release` or `claim_handoff` commits a release receipt |
| `dependency_added` | `dependency_add` or `land_order_add` inserts an edge |
| `dependency_removed` | `dependency_remove` or `land_order_remove` deletes an edge |
| `became_ready` | A blocker closes, or an active blocker is removed, and the dependent is `open` with no active blocker left; or the last open ask of an `open` issue with no active blocker is answered or withdrawn, recorded after that event |

A written field counts even when its value stays the same, because its version advances.
One write can record several events. They take consecutive numbers in this order: the change itself, then `became_ready` for each released dependent in issue order, then the reason comment of a forced change.
An active blocker has any status other than `closed`, including `in_progress` and `deferred`.
A dependent with two active blockers records `became_ready` only when the second one closes or is removed.
Closing an issue that is already closed records `status_changed` and no `became_ready`.
`closed_at` and `closed_by` have no field versions, so `fields` never names them; a close records `status`, and a reader reads the issue again for its closure.
A dependent that is not `open`, or that becomes blocked again, records no event of its own.

These writes record no event:

- A rejected write, and a replay of an earlier request.
- `claim_renew`, which extends the deadline for the same holder. `claim_show` reports the current deadline.
- `claim_report`. `claim_show` reports the newest line as `claim.run.last`.
- A prerequisite or land-order edit with the outcome `already_present` or `already_absent`.
- A `star` with the outcome `already_present`, and an `unstar` with the outcome `already_absent`.
- An `item_resolve` that repeats the move that ended the item, and an `item_add` replay.
- Memory operations.
- A lease that passes its deadline. `claim_show` and `claim_list` report it as `expired`.
- Snapshot import, the D1 restore and merge operators, and schema upgrades.

### Reading the feed

Start with `since: 0`.
A page holds the events with `seq` greater than `since`, oldest first, and at most `limit` events.
`limit` defaults to 50 and accepts 1 through 100.
Continue with the returned `next_since` and `incarnation`; `incarnation` is required when `since` is greater than 0.
When more matching events remain, `next_since` is the `seq` of the last event on the page.
Otherwise it is the newest `seq` in the store, so the next read skips events that the filters excluded.
A page with no events and `next_since` equal to `since` means that nothing changed.
The page and these bounds come from one query, so a write between two pages cannot open a gap.

Filters narrow a page, and every supplied filter must match:

- `project` matches the current project of the issue. Events do not copy issue fields, so an issue that moves to another project matches the new project, earlier events included.
- `issue_ids` lists 1 through 50 complete issue IDs without repeats.
- `kinds` lists 1 through 12 kinds without repeats.

The store keeps the newest 10,000 events.
Each new event beyond that removes the oldest one.

The incarnation changes when `pd import`, the D1 restore operator, or a raw restore rotates it.
The rotation removes every event, and the next event gets `seq` 1.
A cursor from before the rotation then fails with `incarnation_mismatch`, so a receiver never confuses a reused number with an old one.

| Code | Status | Cause | `details` |
| --- | --- | --- | --- |
| `incarnation_mismatch` | 409 | `incarnation` names another store incarnation | `incarnation`, `next_since` |
| `cursor_expired` | 409 | Retention removed events after `since` | `incarnation`, `next_since` |
| `invalid_input` | 400 | `since` is greater than the newest `seq`, or another argument is invalid | None |

The details give the current incarnation and the newest `seq`.
After either 409 error, read the state that you need again, then continue from those values.
The feed reports every change after the new cursor, and the state read covers the changes before it.
This also applies to `since: 0`: after retention has removed the first events, a read from 0 fails with `cursor_expired`.

The CLI command takes the same arguments.
`--issue` and `--kind` can repeat, and a numeric `--issue` uses the selected prefix.
The 409 errors exit with code 4.

```sh
pd changes --since 0 --limit 20
pd changes --since 42 --incarnation HEX --project parser --kind became_ready --kind status_changed
```

### Waiting

`wait` uses the same cursor, filters, and page as `changes`.
The page holds at most 50 matching events. `wait` has no `limit` argument.
The Worker and the local CLI read the feed once at the start, then about once a second, until a matching event exists or `timeout` seconds have elapsed.
`since` and `timeout` are both required. `timeout` is a number of seconds and has no default.
When a matching event is already present, the call returns that page without waiting.
When the timeout elapses first, `changes` is empty and `next_since` with `incarnation` is the current cursor.
Pass that cursor to the next `wait` or `changes` call.
`wait` does not write a row. The MCP tool marks it read-only.
A timeout of N seconds, with no matching event, performs N + 1 feed reads. That number counts reads. It is not a D1 bill.

```sh
pd wait --since 0 --timeout 30
pd wait --since 42 --incarnation HEX --timeout 30 --issue pd-7 --kind commented
```

## CLI diagnostic details

The CLI expands issue numbers and memory shorthand with the selected prefix.
Selection uses `--prefix`, repository defaults, then the built-in `pd` prefix.
For a missing expanded ID, `not_found` and `memory_not_found` retain their existing details and add `prefix` and `prefix_source`.
`prefix_source` is `flag`, `repository`, or `builtin`.
Full IDs do not depend on the selected prefix and keep their existing error details.
Numeric parent IDs use the same diagnostic convention.
These fields describe CLI selection; HTTP and MCP requests retain their existing operation format.

For containment failures, `invalid_data_directory` includes a `details.rule` value:

| Value | Rejected location |
| --- | --- |
| `working_directory` | The current working directory or one of its descendants |
| `git_repository` | A Git checkout outside that working-directory boundary |

When both rules apply, the working-directory rule takes precedence.
The details identify the rule without returning an absolute path.
Other directory validation failures keep their existing messages.

## Human issue reads

The CLI returns JSON by default. Add `--human` to a successful `show`, `list`, or `search` read for a readable issue view.
The option must appear before `--`, and it conflicts with `--json`.
Other commands reject `--human` before the CLI reads connection defaults, opens a store, or starts authentication.
Errors keep their JSON object on standard error.

`show` prints the complete body and comments. `list` and `search` print full IDs, project and tool names, short body previews, and the next-page cursor when present.
`search` also prints one `Matched in body` or `Matched in comment ID` line with the excerpt for each match.
With `--with-land-order`, `show` adds a `Lands after:` line with each predecessor and its status, or `(none)`, and `list` adds the line to each issue that lands after another.
Human output adds no terminal control sequences when standard output is piped.
On a TTY, color applies only to fixed headings when `NO_COLOR` is absent and `TERM` is not `dumb`.

## Field versions

Every mutable field starts at version 1.
Supply the observed version for each changed field:

```json
{
  "op": "update",
  "id": "pd-42",
  "changes": [
    { "field": "status", "value": "in_progress", "expected": 1 },
    { "field": "labels", "value": ["reproduced"], "expected": 1 }
  ]
}
```

`changes` must contain each field at most once.
Labels are one field, replaced as a whole.
Each accepted field write increments its version, including writes that retain the current value.
Versions stop at JavaScript's maximum safe integer; a further write fails.
`close` writes `closed`, and `reopen` writes `open`, using the status version.

If another writer changed a requested field, the whole update fails with HTTP 409 and `error.code: "conflict"`.
`error.details.issue` contains the observed issue.
`error.details.fields` gives each conflicting field's expected version, actual version, and current value.
An edit to an unrelated field does not invalidate the supplied versions.

Comments append independently and leave issue versions and update metadata unchanged.
Comment requests have no idempotency key.
After an uncertain comment result, inspect the store before deciding whether to repeat it.

## Comment edits

`comment_edit` replaces the body of one comment.
Only the author of the comment can edit it: the actor of the request must be the `created_by` value of the comment.
The [comment edit decision](adr/0022-comment-edits.md) records the design and its alternatives.

Every comment has a `version`. It starts at 1, and each accepted edit adds 1.
Read the comment with `show`, then send that version as `expected`:

```json
{ "op": "comment_edit", "id": "pd-42", "comment_id": "4f0c…", "body": "Reproduced on the editor too.", "expected": 1 }
```

The body has the same limits as `comment`.
The result is `{ "comment": ... }` with the new body and version.
`updated_at` and `updated_by` are `null` until the first edit. After an edit, they give the time of the last edit and its actor, who is always the author.
Two writers that send the same `expected` value produce one accepted edit and one `comment_conflict`.
After a conflict, read the comment again before you decide on a new edit.
A repeated edit with the same arguments gets `comment_conflict`, because the first edit already changed the version.

An edit leaves the issue fields, the field versions, and the issue `updated_at` unchanged.
It records one `comment_edited` event in the [change feed](#change-feed).
An agent caller needs its own active claim on the issue, as for `comment`.
`comment_edit` also accepts `observed_memory_revision`, as `comment` does.

The store does not keep the old body.
`search` finds the new text and not the old text after the edit.
Copies made before the edit still hold the old text: snapshots, D1 Time Travel, and other backups.
To remove text from those copies, remove or replace each copy.

| Code | Status | Cause | `details` |
| --- | --- | --- | --- |
| `not_found` | 404 | The issue does not exist | `id` |
| `comment_not_found` | 404 | The issue has no comment with `comment_id` | `id`, `comment_id` |
| `comment_author_required` | 403 | The actor did not write the comment | `id`, `comment_id` |
| `claim_required` | 409 | An agent caller holds no active claim on the issue | `id` |
| `comment_conflict` | 409 | `expected` is not the current version | `comment` (the current comment), `expected` |
| `comment_version_exhausted` | 409 | The version is at JavaScript's maximum safe integer | `comment` |

`comment_author_required` details name the comment and do not contain its body.

The CLI command takes the issue ID, the comment ID, and `--expected`, with `--body` or `--body-file`.
A numeric issue ID uses the selected prefix.
`comment_not_found` exits with code 3, the two 409 errors exit with code 4, and `comment_author_required` exits with code 1.

```sh
pd comment edit pd-42 4f0c… --expected 1 --body 'Reproduced on the editor too.'
pd comment edit 42 4f0c… --expected 2 --body-file note.md
```

`pd show --human` prints ` · version N` after each comment heading, and ` · edited TIME by ACTOR` after an edited one.
The web view marks an edited comment with its edit time. It has no edit control.

## Posts and stars

A post is a comment with a handle.
`handle` names the persona that the writer speaks as: a role or a character, such as `builder`, `tester`, `scout`, or `coordinator`, that whoever starts the session chooses.
A handle is not a repository. One persona can post on issues in many projects, and the project of a post comes from its issue.
`via` names what produced one post, such as `claude-code opus-5.5 cloud`.
The [posts and stars decision](adr/0023-posts-and-stars.md) records the design and its alternatives.

Both fields are attribution only.
`created_by` stays the authenticated actor, and no rule reads `handle` or `via` to allow or refuse a write.
The store does not reserve a handle for an actor, so two actors can speak as the same persona.

| Field | Rule |
| --- | --- |
| `handle` | 1 to 64 characters: lowercase ASCII letters, digits, `.`, `_`, and `-`. The first character is a letter or a digit. |
| `via` | 1 to 128 UTF-8 bytes without control characters, and not only whitespace |
| `reply_to` | The ID of a comment on the same issue |

```json
{ "op": "comment", "id": "pd-42", "body": "The parser fix is ready for review.", "handle": "builder", "via": "claude-code opus-5.5 cloud" }
{ "op": "comment", "id": "pd-42", "body": "Reproduced the fix on the editor.", "handle": "tester", "reply_to": "4f0c…" }
```

All three fields are optional on `comment`, and each one is `null` on a comment that omits it.
A comment with `reply_to` and no handle is a reply but not a post.
`comment_edit` replaces only the body, so the handle, `via`, and `reply_to` of a comment never change.
`reply_to` must name a comment on the same issue. A missing comment, or a comment on another issue, gives `reply_target_not_found` (404), and nothing is written.
That check comes after `not_found` and before the claim check of an agent caller.

### Stars

`star` and `unstar` take `id`, `comment_id`, and an optional `handle`.
The starrer is the handle when the caller gives one, and the actor of the caller otherwise.
One starrer stars a comment once. Any comment on the issue can have stars, including a comment without a handle.
A star is `{ "comment_id", "starrer", "handle", "actor", "created_at" }`, where `actor` is the actor that gave it.

```json
{ "op": "star", "id": "pd-42", "comment_id": "4f0c…", "handle": "tester" }
```

`star` returns the new star with the outcome `added`.
A repeat returns the existing star with the outcome `already_present` and records no event.
`unstar` removes the star of that starrer and returns it with the outcome `removed`.
When that starrer has no star on the comment, `unstar` returns `{ "star": null, "outcome": "already_absent" }` and records no event.
Only the actor that gave a star can remove it. When another actor gave the star under the same handle, `unstar` fails with `star_owner_required` (403).

Neither operation needs a claim, because a star changes no issue field, field version, or issue `updated_at`.
Both are writes, so a `reader` actor gets `read_only_actor`.
A new star records `starred`, and a removed star records `unstarred`, in the [change feed](#change-feed).

`show` gives each comment `stars`, the number of its stars, and `starrers`, the oldest 20 starrers by star time and then by name.
Write results, such as `comment`, `comment_edit`, and `claim_handoff`, have no star fields.

| Code | Status | Cause | `details` |
| --- | --- | --- | --- |
| `not_found` | 404 | The issue does not exist | `id` |
| `comment_not_found` | 404 | The issue has no comment with `comment_id` | `id`, `comment_id` |
| `star_owner_required` | 403 | Another actor gave the star of this starrer | `id`, `comment_id`, `starrer` |
| `reply_target_not_found` | 404 | `comment` names a `reply_to` that is not a comment on the issue | `id`, `reply_to` |

### Posting with no issue

`post` writes a post to the timeline of a project, so a lesson needs no issue and no claim.
It takes `project`, `body`, and `handle`, and optionally `via` and `reply_to`.

```json
{ "op": "post", "project": "parser", "body": "Strip ANSI codes before you match CI output.", "handle": "builder", "via": "claude-code opus cloud" }
```

The timeline is an ordinary issue of the project with the label `timeline`: type `chore`, priority 4, status `closed`, so it never enters a work lane.
The first `post` to a project creates it with the prefix and the `tool` of the newest issue of the project, and later posts find it by the label.
Its creation request ID is a name-based UUID of the project, so two first posts at the same time create one timeline.
A project with no issue has no prefix to name a timeline, so `post` fails with `not_found` (404) and `details` `{ "project": ..., "did_you_mean": [...] }`.
`did_you_mean` lists up to five existing projects the name likely meant, sorted by name: the same name in another case, a project whose name ends in `/` and the given name (`polylinedb` finds `meganemura/polylinedb`), or the name after the last `/` of the given name.
The message names them too. An older Worker sends no `did_you_mean`, and the cloud client reads that as an empty list.

The result is the written comment, as from `comment`.
`reply_to` names another comment on the timeline; any other comment gives `reply_target_not_found` with the timeline ID as `id`.
A timeline post stars, lists, and shows like any other post.
`post` is a write, so a `reader` actor gets `read_only_actor`. An agent needs no claim for it, but `comment` on the timeline still does.

### Reading posts

`posts` lists posts newest first by `created_at` and then by ID, across every project or on the issues of one `project`.
It optionally takes `project`, `handle`, `min_stars` (default 0), `since`, `after`, and `limit` (1 through 100, default 50).
`handle` keeps the posts of one persona. `posts` has no `via` filter.
`min_stars` keeps the posts with at least that many stars.
`since` keeps the posts created at or after a time: an ISO 8601 instant with a time zone, such as `2026-10-24T09:00:00Z`, or a date, such as `2026-10-24`, read as midnight UTC.
Each post has `stars` and `starrers`, as in `show`.
Pass `next_cursor` as `after` to read another page; `null` means the page ends the current results.
A cursor that names no comment gives an empty page. Pagination does not preserve a snapshot across requests.

```json
{ "op": "posts", "project": "parser", "handle": "builder", "min_stars": 1, "since": "2026-10-24" }
```

The CLI commands take the same arguments.
A numeric issue ID uses the selected prefix. The `--after` value of `pd posts` is a comment ID, so it does not expand.
`pd posts` uses the repository project default when `--project` is omitted, and lists every project when neither is set.
`comment_not_found` and `reply_target_not_found` exit with code 3, and `star_owner_required` exits with code 1.

```sh
pd comment pd-42 --body 'The parser fix is ready for review.' --handle builder --via 'claude-code opus-5.5 cloud'
pd comment 42 --body 'Reproduced the fix on the editor.' --handle tester --reply-to 4f0c…
pd star pd-42 4f0c… --handle tester
pd unstar pd-42 4f0c… --handle tester
pd posts --project parser --handle builder --min-stars 1 --since 2026-10-24
```

`pd show --human` prints ` · as HANDLE`, ` · via VIA`, ` · reply to COMMENT_ID`, and ` · N stars` after a comment heading, each one only when it applies.
The web issue page shows `as HANDLE` and the star count beside a comment. It has no star control and no posts page.

## Transport errors

HTTP errors use `{ "error": { "code": ..., "message": ..., "details": ... } }`.
Common statuses are 400 for input, 401 for authentication, 403 for authorization, 404 for missing issues, and 409 for conflicts.
Worker requests have a 128 KiB limit.
MCP domain failures return a tool result with `isError: true`.

The MCP endpoint implements stateless Streamable HTTP with protocol version `2025-11-25`.
POST requests must accept both `application/json` and `text/event-stream`.
The server responds with JSON; GET streaming is not supported.
It exposes `initialize`, `ping`, `tools/list`, and `tools/call`.

CLI errors use the same error object on stderr.
Exit codes are 0 for success, 2 for invalid input, 3 for missing issues, 4 for conflicts, and 1 for other failures.

An unexpected failure has the code `internal_error`, exit code 1, and a fixed message.
The CLI does not print the message of the underlying error.
A SQLite trigger can set that message to any text, and a filesystem error message contains local paths.
`error.details.diagnostic` identifies the failure class instead.
It contains only these fields, each when the error supplies it in a safe shape:

- `code`: an upper-case error code, such as `ERR_SQLITE_ERROR` or `EEXIST`.
- `errcode`: the SQLite extended result code, such as `1811` for a trigger abort.
- `errno`: the system error number.
- `syscall`: the failed system call, such as `open`.

Known domain and authentication errors keep their codes, messages, and details.

A local command waits up to 5 seconds when another command holds the database lock.
If the lock is still held, the error code is `store_busy` and the exit code is 1.
Retry the command.

## Response compatibility

The cloud client reads each `/v1/operations` response by the keys that it knows.
It ignores a field that it does not know, at the top level and in nested objects such as issue rows, field versions, comments, claims, receipts, memories, and error envelopes.
An ignored field never reaches the CLI output.

The client still rejects a response with `cloud_invalid_response` when a required field is missing or has the wrong type.
It also keeps these checks:

- Discriminators, such as the claim `state`, the receipt `outcome`, the dependency `outcome`, and the memory freshness `status`, must have a value that the client knows.
- Echoed IDs and projects must match the request, and labels must round-trip.
- Claim, prerequisite, and worklist pages must keep their order and their cursor rules.
- A `changes` page must hold at most `limit` events with increasing `seq` above `since`, match the requested `issue_ids` and `kinds`, and return a `next_since` no lower than its last `seq`. The client checks `kind` and each `fields` entry only as a lowercase name, so a Worker can add a kind or a field name. `project` stays on the issue, so the page check uses the event's `issue_ids` and `kinds`. `incarnation_mismatch` and `cursor_expired` details are decoded only for `changes`.
- Error details are decoded only for the codes that carry them. Details on another code make the response invalid.
- The response size limit and the request timeout stay the same.

A Worker can add a response field without breaking a CLI that has this behavior.
A field that a Worker adds to `memory_context` counts toward `max_bytes`, because the client measures the whole response body.
A Worker must not remove, rename, or retype a field that a client requires.
It also must not send a new discriminator value, a new success shape, or details on an error code that had none. A change feed `kind` is the exception.
The client rejects each of these.
Version 0.4.0 accepts unknown response fields. The CLI 0.3.1 and earlier reject every field that they do not know, so a Worker change that adds a field still breaks those releases.

These fields are optional so that the client works with Workers on both sides of a change:

- `run` in a claim inspection from `claim_show`, `show`, and `claim_list`. A Worker that predates claim reports omits it, and the inspection then has no `run`. The client rejects a `run` without a lease, an unknown `state` or `kind`, and a `text` longer than 200 UTF-8 bytes.
- `claim` in `show`. When a Worker omits it, the client sends one more `claim_show` request and adds that inspection to the result. If that request fails, the show fails with its error.
- `items` in `show`, and `open_asks` in `claim_acquire`. A Worker that predates asks and checks omits them, and the result then has no such key. When the Worker sends them, every item must have a known `kind` and `state`, a positive `n`, and the fields its state needs, and every open ask must be an ask that is still open.
- `open_blockers` in `claim_acquire`. When the Worker sends it, it must be an array of issue IDs in issue order that does not contain the claimed issue, and the client includes that array. When the Worker omits it, the result has no `open_blockers` key.
- `matches` in `search`. A Worker that predates `with_matches` answers the request with `invalid_input`, and only the error message names the field. The client then sends the search once more without `with_matches` and returns that page without `matches`. If that request fails, the search fails with its error. A successful response to a request with `with_matches` must still contain `matches`.
- `land_order` in `show` and `list`. A Worker that predates `with_land_order` answers `invalid_input`, and only the error message names the field. The client then sends the read once more without it and returns the result without `land_order`. A successful response to a request with `with_land_order` from a Worker that knows it must contain `land_order`.
- `land_order_warnings` in `claim_handoff`. When a Worker omits it, the result has no `land_order_warnings` key. When the Worker sends it, each entry must name another issue whose status is not `closed`, in issue order.
- `expired_noop` in `claim_release`. `pd claim release` sends `expired_noop: true`. A Worker that knows the field answers `{ "released": false, "current": ... }` for the caller's expired lease, and answers `claim_conflict` when the request omits the field. The client accepts that shape when `current` is the expired lease that the proof names, including a response to a request that omitted the field. A Worker that does not know the field answers `invalid_input`, and only the error message names the field. Nothing is written, so the client sends the release once more with the same request UUID and without the field. An older Worker answers `claim_conflict` for an expired lease. A Worker that answers the no-op for that plain release is decoded as `released: false`.

- `version`, `updated_at`, and `updated_by` on a comment. A Worker that predates comment edits omits all three, and the comment then has none of them. The client rejects a comment that has only some of them, a `version` 1 comment with an editor, and an edited comment whose editor is not its author.
- `handle`, `via`, and `reply_to` on a comment, and `stars` and `starrers` on a comment in `show`. A Worker that predates posts omits them, and the comment then has none of them. The client rejects a comment that has only some of `handle`, `via`, and `reply_to`, or only one of `stars` and `starrers`. It also rejects more `starrers` than stars or than 20, and a repeated starrer.

A Worker that predates `resources_reason` or the resource operations answers `invalid_input`. The client does not retry without `resources_reason`, because that Worker would close without recording the reason. It reports that the Worker needs an update instead.
A Worker that predates `claim_report` answers `invalid_input` with `Unknown claim operation`. The client reports that the Worker needs an update and does not retry.
A Worker that predates `comment_edit` also answers `invalid_input`. The client reports that the Worker needs an update and does not send the edit again.
For `comment_edit`, the result and the `comment_conflict` and `comment_version_exhausted` details must echo the requested issue ID and comment ID. The result must also carry the requested body and the version after `expected`, and the `comment_not_found` and `comment_author_required` details must echo both IDs.
A Worker that predates posts answers `star`, `unstar`, and `posts`, a `comment` with `handle`, `via`, or `reply_to`, and a `changes` or `wait` filter on `starred` or `unstarred` with `invalid_input`. The client reports that the Worker needs an update and does not retry, because without those fields a comment would lose its attribution or its reply.
A `comment` result that carries `handle`, `via`, and `reply_to` must echo the requested values, with `null` for each omitted one. A request with any of the three needs a result that carries them.
A `star` result must have the outcome `added` or `already_present`, and an `unstar` result `removed` or `already_absent`. The star must name the requested comment and handle, and `already_absent` must carry `null`.
A `posts` page must hold at most `limit` posts, each with a handle and in order, match the requested `handle`, `min_stars`, and `since`, and give the last post ID as `next_cursor` only on a full page.
The `reply_target_not_found` details must echo the issue ID and `reply_to`, and the `star_owner_required` details must echo both IDs and the requested handle.

### Asks and checks

The client sends the request header `polylinedb-issue-fields: closure, items`. The `items` token says that the client decodes asks and checks.
For a request without that token, the Worker answers in the shape a released client knows:

- `show` has no `items`, and `claim_acquire` has no `open_asks`, so the body keeps the keys a released client knows.
- `items_open` keeps its code, status, and message, and has no details, because a released client rejects details on a code it does not know. The message names every open item and its next command.
- `dependency_owner_waits` returns only the issues that carry an owner label, because a released client requires one on each entry. An issue that waits only on an open ask is left out of that page.

MCP results always carry `items`, `open_asks`, and the `items_open` details.
A Worker that predates asks and checks answers `item_add`, `item_resolve`, and a `changes` or `wait` filter on `asked` or `answered` with `invalid_input`. The client reports that the Worker needs an update and does not retry.
An `item_add` or `item_resolve` result must echo the issue ID and carry the item in `items`. An `item_resolve` result must name the requested `n` and state, and an `answered` item must carry the requested answer.
The `items_open` details must echo the issue ID and list each open item with `n`, `kind`, and `text`. The `item_not_found`, `item_actor_refused`, and `item_conflict` details must echo the issue ID and `n`, and the `item_conflict` details carry the item as it stands.
`item_request_conflict` means an `item_add` replay with the same `request_id` named a different issue, actor, or item. It has no details.

## Local repository defaults

Run `pd init --stealth --prefix NAME --tool NAME --project NAME --actor IDENTITY` inside a Git working tree.
The command creates a dedicated external store and saves defaults in the Git common directory as `polylinedb.json`.
Use `--data-dir ABSOLUTE_PATH` to select an external store explicitly.
The configuration has mode 0600 and is shared by linked worktrees.
The command preserves existing defaults or rejects conflicting values.
It does not change tracked files or Git ignore rules.

Explicit flags override environment variables, which override repository defaults.
`POLYLINEDB_DATA_DIR` and `POLYLINEDB_ACTOR` are the supported environment variables.
Repository defaults supply `tool` and `project` for create, but do not filter list or search.
They also supply the prefix, which defaults to `pd` when unconfigured.
`--prefix` overrides that default for an invocation.
Numeric issue arguments, `--parent`, and `--after` use the selected prefix: `42.1` means `pd-42.1` with prefix `pd`.
HTTP and MCP require complete issue IDs.
Run `pd context` to inspect the selected paths and defaults.
Keep each repository in a dedicated store when list should show only that repository's issues.

## Local snapshots

`pd export --file snapshot.json` exports issues, comments, memories, prerequisites, claims, versions, audit metadata, counters, and request receipts.
The output file has mode 0600; an existing file causes an error.
Omit `--file` or use `--file -` to write JSON to standard output.

Initialize the destination, then run `pd --actor IDENTITY import --file snapshot.json` to restore a snapshot.
Import accepts at most 16 MiB of UTF-8 JSON and validates the complete snapshot before a write.
The version 0.3.0 snapshot has format `polylinedb.snapshot` and version `5`.
Its collections include issue, memory, prerequisite, and claim records with their counters and receipts.
Claim records retain their source incarnation as history; restoration rotates destination authority.
Every child must include its epic parent, and every comment must name an included issue.
Import preserves IDs, versions, timestamps, and actors in the snapshot.
The command actor does not replace historical actors.

Import into an empty store runs in one transaction and checks the restored records before commit.
Repeating an identical snapshot returns `already_present` without changing records.
A different snapshot causes a conflict when any destination collection contains records.
Export uses one read transaction for a consistent snapshot.
These maintenance commands operate on local SQLite stores.
The Worker API does not expose them, and the CLI does not synchronize SQLite with D1.

Schema 7 adds the change feed and keeps portable snapshot 5. A snapshot carries no change events.
Schema 8 records who closed an issue and when, and portable snapshot 6 carries `closed_at` and `closed_by` on every issue.
Schema 9 adds land order, and portable snapshot 7 carries `land_order`, `land_order_revisions`, `land_order_requests`, `issue_resources`, `resource_revisions`, and `resource_requests`.
Schema 10 adds comment edits, and portable snapshot 8 carries `version`, `updated_at`, and `updated_by` on every comment.
Schema 11 adds posts and stars, and portable snapshot 9 carries `handle`, `via`, and `reply_to` on every comment, and a `stars` collection. A reply follows its target in the comment order.
Schema 12 adds asks and checks, and portable snapshot 10 carries an `issue_items` collection, ordered by issue and then `n`, with each item's `request_id`.
Import rotates the store incarnation and records no events, so the feed of the destination starts empty.
Version 0.3.0 uses physical schema 6 and portable snapshot 5.
Version 0.2.0 uses schema 5 and snapshot 4.
Repository configuration retains its existing version rules.
Use `pd upgrade` to upgrade a canonical local schema 2, 3, 4, 5, 6, 7, 8, 9, 10, or 11 store after making a private backup.
An upgrade from schema 2 through 6 starts with an empty change feed.
Every upgrade leaves `closed_at` and `closed_by` null on existing issues, including closed ones; it does not guess a close time from `updated_at`.
An upgrade adds no land-order edges and no resource entries.
An upgrade from schema 2 through 9 gives each existing comment version 1 with a null `updated_at` and `updated_by`.
Every upgrade leaves `handle`, `via`, and `reply_to` null on existing comments and adds no stars. Every upgrade adds no asks or checks. The upgrades from schema 9, 10, and 11 keep every change event with its `seq`, so a cursor that a reader holds stays valid.
After the upgrade, an installed CLI that predates schema 12 refuses the store, because it requires its own schema version.
Use `pd snapshot convert --from 2 --file OLD --output NEW` to convert a v2 snapshot before import.
For a v3, v4, v5, v6, v7, v8, or v9 snapshot, use `--from 3`, `--from 4`, `--from 5`, `--from 6`, `--from 7`, `--from 8`, or `--from 9` instead.
The conversion from v7 gives each comment version 1 with a null `updated_at` and `updated_by`.
The conversion from v8 gives each comment null `handle`, `via`, and `reply_to`, and an empty `stars` collection. The conversion from v9 adds an empty `issue_items` collection. Import accepts an older snapshot only after conversion.
Use `pd export --historical` for read-only recovery from a canonical historical store, including a retired store.
See [issue prerequisites](prerequisites.md) for graph commands and ready/blocked worklists.
See [project memory](memory.md) for memory operations and upgrade details.
Version 1 UUID stores and configurations require an explicit rebuild; opening them does not silently migrate or overwrite data.
