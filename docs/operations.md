# Operation contract

The CLI, HTTP endpoint, and MCP tools share validation and mutation rules.
HTTP accepts JSON at `POST /v1/operations`.
The operation name is the `op` property.
MCP uses that name as the tool name and omits `op` from its arguments.
The local `init` command creates storage; cloud schema installation is an operator action.

## Fields

| Field | Meaning and constraints | Create default |
| --- | --- | --- |
| `id` | Generated UUID; a child appends a dot and UUID, up to eight segments | Generated |
| `tool` | Tool name, nonempty, at most 256 UTF-8 bytes | Required |
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

## Requests and results

| Operation | Arguments besides `op` | Result |
| --- | --- | --- |
| `create` | Required `tool`, `project`, `body`; optional mutable fields and `parent` | `{ "issue": ... }` |
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

Filters are `tool`, `project`, `status`, `type`, `priority`, and one `label`.
All supplied filters must match.
`limit` defaults to 50 and accepts 1 through 100.
Pass `next_cursor` as `after` to read another page; `null` means the page ends the current results.
Results are ordered by ID, and pagination does not preserve a snapshot across requests.
Search matches literal, case-sensitive substrings in bodies or comments.
`show` returns all comments, ordered by timestamp and ID.

## Field versions

Every mutable field starts at version 1.
Supply the observed version for each changed field:

```json
{
  "op": "update",
  "id": "8bc5ba70-78a5-4d27-b937-ef4d8e84186c",
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
Create and comment requests have no idempotency key.
After an uncertain transport result, inspect the store before deciding whether to repeat a mutation.

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
