# Host lifecycle hooks

The CLI can install a local user-scope memory hook for Claude Code, Codex, or Cursor.
This adapter requires the unreleased CLI and a schema 4 store.
Cloud agents do not inherit these user settings.
The hook runs the existing `pd memory context` command from the session workspace.
It uses the connection, credentials, and project selected by the CLI.
It does not start a login or change the selected store after a failure.

```sh
pd agent install claude
pd agent context claude < hook-input.json
pd agent remove claude
```

`pd agent context` reads the host event JSON from standard input.
It returns the host's context JSON and exits successfully when memory retrieval fails.
The context then carries a short error code and tells the agent to continue without assuming that memory is empty.
The hook never sends the CLI's standard error to the host.

The adapter sends up to 8,192 bytes of memory data to a session.
It preserves `omitted`, `next_cursor`, and `notices` from the bounded result.
It encodes memory entries as JSON and labels every field as untrusted project data.
The host context omits explicit database paths and cloud origins.
Its opaque observation token encodes the selected store identity and project.
Keep that token in the session when passing it to ordinary issue operations.

| Host | User settings | Retrieval events | Limits |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json` | Local `SessionStart` on startup, resume, clear, fork, and compact | Compact retrieval runs before the next response. Claude Code Cloud sessions do not load local user settings. |
| Codex | `~/.codex/hooks.json` | Local `SessionStart` on startup, resume, clear, and compact | Compact retrieval runs before the next model request. Codex asks the user to review and trust the hook definition. |
| Cursor | `~/.cursor/hooks.json` | Local `sessionStart` when a composer conversation starts | Delivery is best effort. Cursor does not document a post-compaction event. User settings are unavailable to Cursor Cloud agents. |

Claude Code and Codex provide `cwd` in the event JSON.
Cursor user hooks run from the Cursor settings directory, so the adapter uses `CURSOR_PROJECT_DIR` or one `workspace_roots` entry.
It reports an ambiguous workspace without selecting one when Cursor provides multiple roots and no project directory.

Install and remove operations preserve unrelated settings.
They refuse symlinked settings files, invalid JSON, and matching commands with an unclear owner.
Repeated install and remove operations leave the same state.
The adapter adds no repository files and does not change `pd init --stealth` or Codex trust state.

Tests use temporary user settings and real SQLite memory data.
They verify install, retrieval, removal, repeated commands, and refusal of unsafe settings.
Actual host execution still requires a new session and a compaction event for each supported host.
The installer does not verify that a host loaded its settings.

See the official host references for event and response details:

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Cursor hooks](https://cursor.com/docs/hooks)
