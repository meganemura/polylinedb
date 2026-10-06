# Architecture

polylinedb stores personal issues for local tools and cloud agents.
The local database and the cloud database are independent stores.
Project memories store current knowledge separately from issue status and discussion.
The [memory decision](adr/0003-project-memory.md) records their version and retrieval contract.

## Operations and storage

The issue module owns validation, SQL, field versions, and conflict results.
The CLI opens SQLite directly through Node.
The Worker adapts the same operations to D1, HTTP, and remote MCP.
Database adapters execute ordered statement lists as one transaction.
They do not expose interactive transactions to the issue module.

## Dependency direction

The architecture check orders source modules as domain, adapter, then entrypoint.
Imports may point toward the domain layer or stay within one layer.
The domain includes issue and memory behavior, IDs, schemas, queries, and snapshots.
Adapters include SQLite, D1, cloud access, credentials, and local configuration.
The CLI, Worker, repository scripts, and build configuration are entrypoints.

This rule keeps domain behavior independent from storage, authentication, and transport.
The issue module keeps validation and SQL together because both stores run its ordered statements.
Run `npm exec -- archstrict check` after changing imports or module boundaries.
CI runs `npm run check:architecture`, which checks imports and proves the boundary controls.

The source modules expose capability contracts through these public entries:

| Module | Public entries | Responsibility |
| --- | --- | --- |
| records | `src/records/index.ts`, `src/records/persistence.ts` | Commands and domain types; storage ports, row decoding, schemas, and portable snapshots |
| local-store | `src/local-store/index.ts` | SQLite lifetime, transactions, upgrades, and restoration |
| workspace | `src/workspace/index.ts` | Connection selection and repository settings |
| cloud-client | `src/cloud-client/index.ts` | Authenticated outbound actions; private OAuth, credentials, and transport |
| host-hooks | `src/host-hooks/index.ts` | Host settings and memory retrieval events |
| service | `src/service/index.ts` | HTTP/MCP requests and deployment fetch; private Access verification and D1 adaptation |

The CLI retains its explicit local/cloud branch and closes each local store after execution.
The Worker build uses the service's default fetch entry.
Capability rules restrict public imports to each module's required contracts.
Node and Worker environment tags prevent imports between those hosts.
Run `npm run check:architecture` to verify the graph and deliberate boundary controls.
The [capability decision](adr/0006-capability-boundaries.md) records the module plan and verification limits.

Each mutable field has its own version, starting at 1.
An update supplies the observed version for each field it changes.
One conditional SQL UPDATE checks every supplied version and changes every requested field atomically.
A stale version rejects the whole update.
An unrelated field update can still succeed.
Every accepted write increments its field version, even when its value is unchanged.
This protects against a value changing and later returning to its original value.

Comments append independently and do not change issue field versions.
Each memory has one version for its title and body. Updates and deletion require that observed version.
Memory IDs use separate persistent counters, and creation receipts survive memory deletion.
The shared operation dispatcher exposes issue and memory operations to CLI, HTTP, and MCP.
The claim module owns separate ownership aggregates and immutable successful mutation receipts.
Issue status writes compose the ownership predicate with field CAS inside their conditional SQL update.
Session identity, request identity, and the authenticated actor have distinct roles.
Store incarnation binds every proof to the current authority and invalidates imported claim history after restoration.
See [ownership design](adr/0009-issue-ownership.md) for database time, cumulative counters, retry admission, and rollback guarantees.
Mutations are never automatically retried with fresh versions.
After an uncertain network result, read the issue before deciding what to do next.

## Operation policy

The `Operation` union has one typed policy row per operation.
Each row records local read or write access and the current MCP hints.
A new operation without a policy row fails type checking.
The MCP list handler fails if a schema key has no policy row.

The CLI requires an actor from a flag, environment variable, or repository default before it parses a mutation payload.
It maps `ready` and `blocked` to `dependency_worklist` for this check.
The `import` and `upgrade` commands stay in the CLI because they are outside `Operation`.
The CLI keeps its existing unknown-command error.

MCP hints remain separate from local access rules.
The service keeps its current conservative values, including `readOnlyHint: false` for dependency reads.
The policy always sets `openWorldHint` to `false`.

## Identity

Local actors provide attribution for a database protected by local filesystem permissions.
Cloud actors come from a verified Cloudflare Access assertion and an explicit actor allowlist.
A caller cannot select its cloud actor through operation arguments.
OAuth credentials stay in the agent host's connector infrastructure.
Cloudflare Managed OAuth handles authorization and refresh.
The Worker verifies the Access assertion before it touches D1.

## Containment and queries

A root ID combines a prefix and a positive integer, such as `pd-42`.
A child ID appends a dot and a positive integer to an epic ID, such as `pd-42.1`.
Each prefix has a root counter, and each parent has a separate child counter.
Prefixes identify numbering namespaces within a store; they do not restrict the mutable project field.
The same ID in two independent stores identifies different records.
The database records the parent for atomic containment checks.
A parent with children must remain an epic.
Closing a parent does not close its children.

Search matches literal, case-sensitive substrings in issue bodies and comments.
List and search order prefixes lexically and each numeric segment numerically.
Pagination does not promise a snapshot across separate requests.

## Number allocation and request replay

An atomic SQL batch increments a persistent counter, inserts the issue, and records the creation request.
SQLite and D1 execute the same statements in one transaction.
The request record holds a caller-supplied UUID, the authenticated actor, the normalized payload, and the issued ID.
An identical request reuses the issue and returns its current state without allocating another number.
Reuse with a different actor or payload fails with a conflict.
Comment IDs remain UUIDs; issue IDs use the numbering scheme above.

Persistent counters retain issued numbers independently of issue rows.
This supports gaps and prevents number reuse after snapshot restoration.
Computing a maximum before insertion would race; deriving it from surviving rows would lose the issued maximum after deletions.
Counters and request records therefore belong in snapshots alongside issues and comments.
There is no merge between independently writable stores, so issue IDs do not need decentralized generation.

## Verification boundary

Local tests exercise actual SQLite files, CLI subprocesses, and signed JWTs.
A local D1 runtime can check binding behavior.
Production D1, Access policy, OAuth refresh, and cloud-host reconnects require deployment and owner authorization.
A local pass does not establish those production results.
