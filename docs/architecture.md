# Architecture

polylinedb stores personal issues for local tools and cloud agents.
The local database and the cloud database are independent stores.

## Operations and storage

The issue module owns validation, SQL, field versions, and conflict results.
The CLI opens SQLite directly through Node.
The Worker adapts the same operations to D1, HTTP, and remote MCP.
Database adapters execute ordered statement lists as one transaction.
They do not expose interactive transactions to the issue module.

Each mutable field has its own version, starting at 1.
An update supplies the observed version for each field it changes.
One conditional SQL UPDATE checks every supplied version and changes every requested field atomically.
A stale version rejects the whole update.
An unrelated field update can still succeed.
Every accepted write increments its field version, even when its value is unchanged.
This protects against a value changing and later returning to its original value.

Comments append independently and do not change issue field versions.
Mutations are never automatically retried with fresh versions.
After an uncertain network result, read the issue before deciding what to do next.

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
