# Changelog

## Unreleased

- Reject unsupported Node runtimes before loading CLI operations and report package and Node versions with `pd --version`.
- Document fixed-Node launch wrappers for installations managed by version managers.
- Report valid Worker access configuration errors with safe CLI guidance.
- Distinguish busy OAuth callback ports from denied loopback access.
- Return `store_retired` when the CLI writes to a retired local store.
- Pin Node 24 GitHub Actions and check Ubuntu 24.04 and 26.04 with Node 24 and 26.
- Install and remove user-scope memory hooks for local Claude Code, Codex, and Cursor sessions.
- Detect project memory changes during issue operations with an optional context observation token.
- Upgrade local schema 2 or 3 stores explicitly to schema 4 for memory revisions and store identity.
- Document D1 upgrades and identity rotation after a raw database restore.
- Preserve an existing SQLite journal mode when opening a local store.
- Check architecture layers in CI and add seeded behavior properties and bounded mutation tests.

## 0.1.0 (2026-10-04)

### Task and memory operations

- Store project knowledge with `pd memory` and the corresponding HTTP and MCP operations.
- Retrieve bounded project context through the bundled agent skill.
- Detect stale memory updates and deletions with record versions.
- Retain creation receipts after memory deletion so retries cannot recreate deleted entries.
- Transfer issues and memories with snapshot v3, including counters and audit records.
- Upgrade local schema 2 stores explicitly and convert existing v2 snapshots.

### Connections and authentication

- Select named local SQLite or Cloudflare connections from the CLI.
- Keep repository defaults in Git metadata and local databases outside the checkout.
- Authenticate the CLI with OAuth PKCE and a temporary loopback callback.
- Store credentials in macOS Keychain or Linux Secret Service.
- Refresh credentials across local processes and revoke grants on logout.
- Display centered authorization callback pages with light and dark themes.

### Cloud deployment

- Document Worker, D1, and Access Managed OAuth setup with the Cloudflare CLI.
- Document connector setup and observed results for cloud agent hosts.
- Restore snapshots into an isolated D1 destination with resumable writes and complete readback verification.
- Add disjoint local records to an existing D1 store through a guarded operator batch, then change shared repository defaults.
- Retire the previous local store for writes while retaining read access and recovery snapshots.

Automatic host hooks for memory retrieval remain separate work. The bundled skill supplies the retrieval instructions.

## 0.0.1

The initial version provides a local SQLite issue store and shared operations for a Cloudflare Worker backed by D1.
Issue updates use field versions. Creation requests use UUIDs for retry detection.
