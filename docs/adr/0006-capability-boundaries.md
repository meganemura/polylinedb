# Organize modules by the knowledge they own

## Problem

The source began with one public module per file.
Layer rules protected the shared operations from adapters and entrypoints.
Files in the same layer could still import each other.
The CLI imported cloud composition, OAuth errors, and credential errors through separate files.

We need boundaries that hide implementation decisions and preserve existing behavior.
Directory names and import counts alone do not establish those boundaries.

## Decision

Group modules around capabilities and the knowledge they protect.
Keep execution environment and layer classifications as separate constraints.

The first implemented module is `src/cloud-client/`.
Its `index.ts` exposes `createCloudClient`, authentication error categories, and the non-secret `AuthStatus` type.
The client retains four actions: `execute`, `login`, `status`, and `logout`.
OAuth discovery, callbacks, refresh, revocation, credential commands, locks, and HTTP response validation stay internal.
The CLI imports that public entry.
Internal tests exercise individual implementations outside the production module graph.

The capability groups now have explicit public entries.

The records group now uses `src/records/index.ts` for commands, identifiers, and domain types.
Its `persistence.ts` entry supplies storage ports, snapshots, schema statements, and row decoding for adapters.
Cloud response validation deliberately uses that row-decoding contract.
The SQL catalog, generated queries, mutation handlers, and freshness implementation remain internal.
The local-store group now exposes initialization, opening, and upgrades from `src/local-store/index.ts`.
The CLI still closes each opened store in its explicit local branch.
The workspace group exposes selection and mutations through `src/workspace/index.ts`.
Its legacy defaults and named selection types have explicit public names.
Git metadata formats and settings locks stay in private implementation files.
The host-hooks group exposes its existing host actions from `src/host-hooks/index.ts`.
Hook subprocesses still invoke the CLI entry from `process.argv[1]`.
The service group exposes its handler, deployment fetch entry, and environment types from `src/service/index.ts`.
Access verification and D1 adaptation remain private.

| Capability | Knowledge it owns |
| --- | --- |
| records | Issue and memory rules, operation dispatch, SQL plans, revisions, and portable snapshot validation |
| local-store | SQLite lifetime, ordered transactions, upgrades, and snapshot restoration |
| workspace | Named connections, Git metadata, selection precedence, and path validation |
| cloud-client | Authenticated outbound operations, OAuth, credential storage, and response validation |
| host-hooks | Host settings, event translation, and CLI invocation |
| service | HTTP/MCP envelopes, Access verification, and D1 adaptation |

Issue and memory behavior can remain separate private files under records.
Their shared dispatcher owns the freshness advisory after an issue operation completes.
Storage callers need an explicit persistence contract distinct from ordinary command callers.
The public entries name the types that their callers receive.

Retain the existing ordered `SqlExecutor` contract during these structural changes.
Both SQLite and D1 already implement it.
Do not add a generic provider registry or a new query abstraction for this migration.
The CLI keeps its explicit local/cloud branch and visible resource lifetime.

## Constraints

The domain layer must not import adapters or entrypoints.
Node modules and Worker modules must not import each other, including type imports.
Portable and Worker code must not import Node builtins.
Every module exposes explicit public entries; production callers must not bypass them.

Classification entries retain both layer and environment tags.
The layer rule already rejects domain-to-host dependencies.
A second rule for that same relationship would duplicate the existing constraint.

Capability tags constrain public imports within each runtime as well.
Local-store, workspace, host-hooks, and service import records rather than each other's implementation knowledge.
Cloud-client imports records and workspace configuration.
The CLI composes the Node capabilities directly.

## Change scenarios

A memory operation changes its record contract and behavior.
CLI syntax, MCP descriptions, and cloud response validation change when that public contract changes.
Those edits reflect actual protocol consumers.
A directory move does not remove the need for them.

An alternate credential store changes cloud-client internals through the existing credential-store interface.
A different authentication protocol changes client composition and actions.
A Worker authentication route changes service verification.
The bearer token, Access assertion, and domain actor retain their distinct roles.

## Alternatives

One shared, Node, and Worker module would expose broad runtime surfaces.
Maintenance callers would need storage operations through the same Node entry as the CLI.
Capability modules give those callers more specific contracts.
We retain runtime isolation from this alternative as an independent check.

Public issue and memory modules would require another owner for dispatch, snapshots, and freshness.
Private record submodules preserve their distinct rules under the shared record contract.

A universal execution object would add forwarding while hiding little of the actor and lifetime decisions.
The current local/cloud branch remains explicit.

## Verification and limits

Run `npm run check:architecture` to check the graph and prove its boundaries with in-memory imports.
The controls cover public entries, private implementations, both runtime directions, domain-to-host access, and Node builtin access.
Separate controls prove each capability's allowed-import rule, including forbidden public imports within Node.
Each forbidden control must identify its intended rule and config entry.
Every simulation must also return its expected exit status.

Archstrict 0.2.1 reports `node:sqlite` imports as unresolved in this project.
A deliberate portable `node:sqlite` import also passes its current simulation.
Resolved builtin controls therefore do not establish detection for every builtin.
The unresolved-import issue needs a tool fix; builds and runtime tests remain separate verification obligations.
Third-party package internals and global runtime APIs also require build and runtime checks.

Structural changes preserve field conflicts, creation receipts, transaction order, snapshot values, and freshness behavior.
Package installation tests verify the emitted paths and the CLI binary.
Local SQLite, D1, and Worker checks do not establish production deployment or host authentication results.
