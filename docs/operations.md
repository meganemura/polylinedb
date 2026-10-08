# Operation contract

The CLI, HTTP endpoint, and MCP tools share validation and mutation rules.
HTTP accepts JSON at `POST /v1/operations`.
The operation name is the `op` property.
MCP uses that name as the tool name and omits `op` from its arguments.
The local `init` command creates storage; cloud schema installation is an operator action.

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
| `show` | `id` | `{ "issue": ..., "comments": [...] }` |
| `list` | Optional filters | `{ "issues": [...], "next_cursor": ... }` |
| `search` | `query`, optional filters, optional `with_matches: true` | Same as list; with `with_matches`, also `"matches": [...]` |
| `comment` | `id`, `body` | `{ "comment": ... }` |
| `update` | `id`, nonempty `changes` array | `{ "issue": ... }` |
| `close` | `id`, `expected` status version | `{ "issue": ... }` |
| `reopen` | `id`, `expected` status version | `{ "issue": ... }` |
| `actor` | None | `{ "actor": ... }` |
| `dependency_list` | `dependent_id`; optional `after`, `limit` | `{ "dependent_id": ..., "revision": ..., "blockers": [...], "next_cursor": ... }` |
| `dependency_add`, `dependency_remove` | `dependent_id`, `blocker_id`, `expected_revision`, `request_id` | `{ "dependency": { "dependent_id": ..., "blocker_id": ..., "revision": ..., "outcome": ... } }` |
| `dependency_worklist` | `state: "ready"` or `"blocked"`; optional issue filters except `status` | Same as list |
| `claim_show` | `issue_id` | `{ "claim": ... }` |
| `claim_list` | Optional `tool`, `project`, `after`, `limit` | `{ "claims": [...], "next_cursor": ... }` |
| `claim_acquire` | `issue_id`, observed `incarnation`, `session_id`, `request_id`; optional `ttl`, nullable `agent_label` | `{ "claim_receipt": ... }` |
| `claim_renew` | `claim_proof`, `expected_revision`, `request_id`; optional `ttl` | Same as claim acquire |
| `claim_release` | `claim_proof`, `expected_revision`, `request_id` | Same as claim acquire |

Unknown arguments are rejected.
The cloud actor comes from authentication, so requests cannot supply an actor.
`parent` must name an existing epic.
The parent relationship is immutable; an epic with children cannot change to another type.
Prerequisites form a separate acyclic graph. They can cross projects within the selected store.
See [issue prerequisites](prerequisites.md) for aggregate conflicts, immutable request receipts, and readiness semantics.
Close and updates that request `in_progress` or `closed` accept `force: true` with a nonempty `reason` for an explicit exception.
The reason becomes an attributed comment in the successful status transaction. Ordinary operation results retain their existing shapes.
Version 0.3.0 uses schema 6 and adds issue ownership while retaining all seven ordinary issue fields.
Version 0.2.0 uses schema 5.
`update`, `close`, and `reopen` accept optional `claim_proof` with `issue_id`, `incarnation`, `session_id`, and `generation`.
Once acquisition activates an issue, every requested status change requires a current unexpired proof at the write.
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

`request_id` is a lowercase UUID required by HTTP and MCP create requests.
The CLI accepts `--request-id` and generates one when omitted.
To retry across CLI invocations, specify the same request ID explicitly.
The same request ID, normalized creation arguments, and actor return the current state of the original issue.
A different payload or actor produces `request_conflict` with status 409.
Replay does not increment counters, update the issue, or reset later edits.
Request IDs are scoped to the store and retained with its data.

Filters are `tool`, `project`, `status`, `type`, `priority`, and one `label`.
All supplied filters must match.
`limit` defaults to 50 and accepts 1 through 100.
Pass `next_cursor` as `after` to read another page; `null` means the page ends the current results.
Results are ordered by prefix, then by the numeric segments of each ID; a parent precedes its children.
Pagination does not preserve a snapshot across requests.
Search matches literal, case-sensitive substrings in bodies or comments.
`show` returns all comments, ordered by timestamp and ID.

## Search matches

`search` finds literal, case-sensitive text in issue bodies and comments.
A request with `with_matches: true` also returns `matches`, which tells where each issue on the page matched.
A request without it returns only `issues` and `next_cursor`, so clients of version 0.3.1 and earlier still decode the result.
The CLI and the MCP `search` tool always request matches. The MCP tool does not take `with_matches` as an input.
A server that predates this field rejects it as an unknown argument, so update the Worker before the CLI.

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

Version 0.3.0 uses physical schema 6 and portable snapshot 5.
Version 0.2.0 uses schema 5 and snapshot 4.
Repository configuration retains its existing version rules.
Use `pd upgrade` to upgrade a canonical local schema 2, 3, 4, or 5 store after making a private backup.
Use `pd snapshot convert --from 2 --file OLD --output NEW` to convert a v2 snapshot before import.
For a v3 or v4 snapshot, use `--from 3` or `--from 4` instead.
Use `pd export --historical` for read-only recovery from a canonical historical store, including a retired store.
See [issue prerequisites](prerequisites.md) for graph commands and ready/blocked worklists.
See [project memory](memory.md) for memory operations and upgrade details.
Version 1 UUID stores and configurations require an explicit rebuild; opening them does not silently migrate or overwrite data.
