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
| `search` | `query`, optional filters | Same as list |
| `comment` | `id`, `body` | `{ "comment": ... }` |
| `update` | `id`, nonempty `changes` array | `{ "issue": ... }` |
| `close` | `id`, `expected` status version | `{ "issue": ... }` |
| `reopen` | `id`, `expected` status version | `{ "issue": ... }` |
| `actor` | None | `{ "actor": ... }` |

Unknown arguments are rejected.
The cloud actor comes from authentication, so requests cannot supply an actor.
`parent` must name an existing epic.
The parent relationship is immutable; an epic with children cannot change to another type.

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

`pd export --file snapshot.json` exports issues, comments, memories, versions, audit metadata, counters, and creation requests.
The output file has mode 0600; an existing file causes an error.
Omit `--file` or use `--file -` to write JSON to standard output.

Initialize the destination, then run `pd --actor IDENTITY import --file snapshot.json` to restore a snapshot.
Import accepts at most 16 MiB of UTF-8 JSON and validates the complete snapshot before a write.
The snapshot has format `polylinedb.snapshot` and version `3`.
Its arrays are `issues`, `comments`, `counters`, `requests`, `memories`, `memory_counters`, and `memory_requests`.
Every child must include its epic parent, and every comment must name an included issue.
Import preserves IDs, versions, timestamps, and actors in the snapshot.
The command actor does not replace historical actors.

Import into an empty store runs in one transaction and checks the restored records before commit.
Repeating an identical snapshot returns `already_present` without changing records.
A different snapshot causes a conflict when any destination collection contains records.
Export uses one read transaction for a consistent snapshot.
These maintenance commands operate on local SQLite stores.
The Worker API does not expose them, and the CLI does not synchronize SQLite with D1.

Schema and snapshot versions are now 3. Repository configuration retains its existing version rules.
Use `pd upgrade` to explicitly upgrade a local schema 2 store after making a private backup.
Use `pd snapshot convert --file OLD --output NEW` to convert a v2 snapshot before import.
See [project memory](memory.md) for memory operations and upgrade details.
Version 1 UUID stores and configurations require an explicit rebuild; opening them does not silently migrate or overwrite data.
