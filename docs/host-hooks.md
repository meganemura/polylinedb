# Host lifecycle hooks

The CLI can install a local user-scope memory hook for Claude Code, Codex, or Cursor.
Lifecycle adapters are available from version 0.2.0.
Use a store upgraded to the schema required by the installed CLI.
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
The hook stops its memory read after 10 seconds and reports `unavailable`, which leaves time to answer inside the 15-second limit in the installed host settings.

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
On October 4, 2026, local Codex and Claude Code sessions verified startup and post-compaction delivery.
Both checks used isolated project hooks and a schema 4 store.
The event log recorded `startup` and `compact`, successful adapter exits, and the expected memory marker in each response.
The user reported that each session returned the marker after each event.
These checks used the unreleased source CLI and synthetic memory, not a deployed cloud store or the user-scope installer.
A local Cursor session also verified `sessionStart` delivery with the same isolated store.
After the manual adapter check, another invocation returned the expected marker, and the user reported it in the new session.
Cursor post-compaction delivery remains outside this adapter's supported events.
The installer does not verify that a host loaded its settings.

See the official host references for event and response details:

- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [Cursor hooks](https://cursor.com/docs/hooks)
