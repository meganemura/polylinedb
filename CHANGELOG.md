# Changelog

## Unreleased

- Record who closed an issue and when in `closed_at` and `closed_by`. A status change into `closed`, forced or not, sets them; reopen and any other status change away from `closed` clear them; other edits keep them. Issues closed before the upgrade keep null. Local results, MCP, and `pd show --human` report them. `/v1/operations` omits them, so the cloud CLI 0.3.1 keeps working. Schema 7 adds the columns: run `pd upgrade` for local stores, and apply `node scripts/schema.ts --upgrade-from 6` to D1 before deploying the Worker. Snapshot 6 carries the fields; convert snapshot 5 with `pd snapshot convert --from 5`.
- Name every unexpected and missing field in `invalid_input` errors, with a path for nested fields (`changes[0].note`) and `<path>: expected <type>` for a wrong structure. A message echoes at most 10 names, each cut to 64 bytes, and prints `<invalid name>` for a key that is not shaped like an identifier. "Unknown field" now reads "Unexpected field".
- Name the session in claim acquisition errors. Without `--session-id` or `POLYLINEDB_SESSION_ID`, `pd claim acquire` exits with a usage error, and the Worker and MCP `claim_acquire` report `session_id` instead of `request_id` for a missing or malformed session UUID. A malformed `session_id` in a claim proof is reported the same way. No session UUID is generated, because a generated UUID would leave other processes unable to renew or release the claim.
- Print help and `pd --version` on an unsupported runtime, such as Bun, without loading storage or SQL modules. Every other command still exits with `unsupported_runtime`.
- Add the actor kind `human` or `agent` to local operations through `--actor-kind` or `POLYLINEDB_ACTOR_KIND`; the kind defaults to `human`.
- Keep issues labeled `main-lock` out of the ready worklist, and document the main-lock claim and the `tip:` comment for publishing.
- Require a local agent to name its own actor through `--actor` or `POLYLINEDB_ACTOR` instead of the shared repository actor, and document one actor per agent host.
- Let an agent actor claim only an issue labeled `ready`, and read only labeled issues from the ready worklist.
- Reject agent updates, comments, close, reopen, and prerequisite edits with `claim_required` unless the agent holds an active claim on the issue; the check and the ready-label check for acquisition run in the same transaction as the write.
- Decide issue, claim, creation, and prerequisite rejections in a pure transition module that SQLite and D1 share, and prove it against the SQL writes with a differential test.
- Let each cloud `ACCESS_ACTORS` entry carry a role: `human`, `agent`, or `reader`. A bare actor ID stays a human who writes. The Worker passes the actor kind to the agent gates, so a service-token agent claims only `ready` issues and writes only under its own claim. A `reader` gets `read_only_actor` on every write, claims included. A duplicate actor ID now makes the configuration invalid.
- Report `read_only_actor`, `not_ready`, and the agent `claim_required` from the cloud through the CLI with their codes instead of `denied` or `cloud_invalid_response`.
- Advertise MCP hints from the store effect of each tool. `dependency_list` and `dependency_worklist` are read-only. Every mutation except `comment` is idempotent, because a repeat replays its request receipt or fails its version check. `dependency_remove` is destructive. The `create` description now says to retain the request UUID for retries.
- Print a fixed message for an unexpected CLI failure instead of the underlying error message, so SQLite trigger text and local paths stay out of the output. `error.details.diagnostic` gives the error `code`, SQLite `errcode`, `errno`, and `syscall` when they have a safe shape.
- Return the claim inspection as `claim` from `show` in the CLI, the Worker API, and MCP, so a caller reads the `store_incarnation` for `claim_acquire` without `claim_show`. The human output adds a `Claim` line. The cloud client requires the new field, so update the CLI and the Worker together: until both are updated, a cloud `pd show` reports `cloud_invalid_response`, from an older CLI against an updated Worker and from an updated CLI against an older Worker. MCP clients are not affected.

## 0.3.1 (2026-10-06)

- Distinguish denied authentication state access from a busy authentication lock without exposing filesystem paths.
- Report signing-key outages with safe guidance and retain request UUIDs for explicit retries.
- Preserve complete trigger definitions in cloud setup batches and compare the database version with the deployment source.
- Add session-owned issue claims with database deadlines, incarnation fencing, and immutable request receipts.
- Require a current claim proof for status writes after claim activation, including close, reopen, and forced prerequisite overrides.
- Preserve claim history through schema 6 upgrades, snapshot 5 restoration, and guarded store transfers.
- Add explicit `--human` output for issue show, list, and search, with quiet terminal headings and safe text rendering.
- Preserve memory freshness notices in human output; keep JSON as the default and disable styling for pipes and `NO_COLOR`.

<a id="upgrade-from-020"></a>

### Upgrade from supported older versions

Version 0.3.1 uses schema 6 and snapshot 5. Version 0.2.0 does not provide claim commands.
Local upgrades accept canonical schemas 2, 3, 4, and 5 directly.
Version 0.1.0 uses schema 3 and can upgrade directly to 0.3.1 without installing 0.2.0 first.
Version 0.2.0 uses schema 5 and follows the same procedure.
The CLI requires Node.js 24.20 or later in the 24.x line, or Node.js 26.7 or later.

Stop all writers, including agents, hooks, and background processes, before installation.
Install version 0.3.1, then export a private backup before the upgrade.
Use the same named local connection for every command:

```sh
npm install --global polylinedb@0.3.1
pd --connection LOCAL export --historical --file /absolute/private/path/before-upgrade.json
pd --connection LOCAL --actor local:operator upgrade
pd --connection LOCAL list --project PROJECT
pd --connection LOCAL memory context --project PROJECT
```

Replace `LOCAL` and `PROJECT` with your connection name and project.
For an unnamed local store, replace `--connection LOCAL` with the same `--data-dir /absolute/store/path` in every `pd` command.
Choose a new backup file outside Git checkouts. The export creates the file with mode `0600` and refuses an existing file.
The new CLI's `export --historical` reads schemas 2 through 5 without changing the store and writes snapshot 5.
The upgrade does not create a backup automatically.
Local mutations require an actor. You can also supply the actor through `POLYLINEDB_ACTOR` or repository defaults.
The upgrade preserves existing records, keeps existing prerequisite graphs, and leaves issues unclaimed.
Check the preserved records before restarting writers.
For schema 6, use ordinary `export` for backups. Historical export rejects schema 6, and another upgrade reports `already_current`.
Retired stores remain read-only and refuse upgrades.
Recover a retired schema 2 through 5 store through historical export and import into a separate fresh store.
For a retired schema 6 store, use ordinary export instead. Keep the original store's retirement guards in place.

For D1, stop writers and back up the database before changing its schema or Worker.
Use the [database upgrade procedure](docs/d1-migration.md#upgrade-an-existing-schema-2-3-4-or-5-deployment) before deploying the matching Worker.
The CLI does not upgrade D1.

Snapshot file conversion is separate from a local database upgrade.
Convert an existing snapshot 4 file explicitly before import:

```sh
pd snapshot convert --from 4 --file OLD --output NEW
```

Conversion writes snapshot 5 with empty claim collections. Versions 2 and 3 also require their explicit conversion option.
Restoration preserves claim history but gives the destination new authority. Old proofs cannot authorize new writes there.
Check the installed CLI help or MCP schemas before using the [claim workflow](docs/claims.md).

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
