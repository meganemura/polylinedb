# Changelog

## Unreleased

- Distinguish denied authentication state access from a busy authentication lock without exposing filesystem paths.
- Report signing-key outages with safe guidance and retain request UUIDs for explicit retries.
- Preserve complete trigger definitions in cloud setup batches and compare the database version with the deployment source.

## 0.2.0 (2026-10-05)

- Add prerequisite graphs with aggregate CAS, immutable mutation receipts, and ready/blocked worklists.
- Guard start and close with active prerequisites; store explicit forced exceptions as atomic attributed comments.
- Upgrade canonical schemas 2, 3, and 4 to schema 5 and transfer graph state through snapshot 4.
- Recover canonical retired historical stores through read-only export.

- Explain the prefix source when a shorthand issue or memory ID is missing.
- Identify the containment rule that rejects a local data directory.
- Clarify import actors, parent conversion, external knowledge transfer, and manual blocker conventions in the migration guide.
- Define the affected tool separately from the project and audit actor.
- Reject unsupported Node runtimes before loading CLI operations and report package and Node versions with `pd --version`.
- Document fixed-Node launch wrappers for installations managed by version managers.
- Report valid Worker access configuration errors with safe CLI guidance.
- Distinguish busy OAuth callback ports from denied loopback access.
- Return `store_retired` when the CLI writes to a retired local store.
- Pin Node 24 GitHub Actions and check Ubuntu 24.04 and 26.04 with Node 24 and 26.
- Install and remove user-scope memory hooks for local Claude Code, Codex, and Cursor sessions.
- Detect project memory changes during issue operations with an optional context observation token.
- Add memory revisions and store identity through explicit local upgrades, now targeting schema 5.
- Document D1 upgrades and identity rotation after a raw database restore.
- Preserve an existing SQLite journal mode when opening a local store.
- Check architecture layers in CI and add seeded behavior properties and bounded mutation tests.

### Upgrade from 0.1.0

The CLI requires Node.js 24.20 or later in the 24.x line, or Node.js 26.7 or later.
This release uses database schema 5 and snapshot format 4. Stop writers and preserve a private backup before an upgrade.

For a local connection, install the new CLI and use the same named connection for each command:

```sh
npm install --global polylinedb@0.2.0
pd --connection LOCAL export --historical --file /absolute/private/path/before-upgrade.json
pd --connection LOCAL upgrade
pd --connection LOCAL list --project PROJECT
pd --connection LOCAL memory context --project PROJECT
```

Replace `LOCAL` with your local connection name. Choose a new backup path outside Git.
The upgrade preserves existing records and creates empty prerequisite graphs.
Retired stores remain read-only. Recover them with historical export into a separate destination.

For Cloudflare, stop writers and back up D1 before changing its schema or Worker.
Use the [D1 upgrade procedure](docs/d1-migration.md#upgrade-an-existing-schema-2-3-or-4-deployment).
Apply the migration for the current schema, verify the preserved records, then deploy the new Worker.
The CLI's `upgrade` command does not upgrade D1.

Convert an older snapshot before import:

```sh
pd snapshot convert --from 2 --file OLD --output NEW
```

For snapshot 3, use `--from 3` instead. Conversion writes snapshot 4 and preserves original creation receipts.
Review source IDs before adding structured prerequisites. Existing blocker text does not create graph edges automatically.

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
