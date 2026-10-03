# Generate and execute read queries with solarsql

The CLI and Worker use solarsql 0.7.1 for `show`, `list`, and `search`.
The SQL catalog is `src/issue-queries.json`.
The Node and D1 adapters execute its generated queries through the same operation handler.

The existing schema uses non-STRICT tables.
Schema-only analysis preserves that schema and reports flexible columns as `SqlValue`.
The existing row parsers validate those values before they become issues or comments.
Converting every column with SQL casts would hide invalid stored values.

`npm run generate:sql` initializes the actual schema in memory and extracts its CREATE statements.
It then runs the installed solarsql analyzer and writes `src/solarsql.generated.ts`.
Commit that generated file when changing the schema or catalog.
`npm run check:sql` checks freshness without changing the generated file.
Type checks and both package builds run this check.
The generator does not open a user's database.

`show` joins one issue with its comments in one SELECT.
This preserves a consistent database view on both engines.
Solarsql's Node read batch does not establish a transaction around several reads.
A single JSON aggregate would put every comment into one row and could exceed D1's row limit.
The join repeats issue columns but keeps each comment in its own row.

List and search share named parameters and fixed optional predicates.
Absent optional filters bind NULL; ordering and cursors use the stored numeric sort key.
An absent cursor binds the empty string, which precedes every valid sort key.
Catalog variants use direct tool, project, and status predicates for each available prefix of the scope index.
Label filtering expands the candidate issue's JSON labels in a correlated EXISTS query.
Version 0.7.1 can analyze this reference to the outer issue.
This removes the additional primary-key join required by the 0.7.0 analyzer.

Mutation batches retain their existing implementation.
Creation allocates a number and records its retry key in one transaction.
Updates observe rejected field versions in the transaction that attempts the change.
SQLite retains `BEGIN IMMEDIATE`, and D1 retains its atomic batch.
Snapshot import and export retain their transactions and format version 2.

Full module adoption would add typed commands and require a STRICT schema migration.
It would also replace UPDATE RETURNING and redesign mutation result handling.
We defer that change to preserve existing stores while adopting generated reads on both engines.

Validate changes with the issue tests, snapshot tests, D1 and Worker integration tests, and installed-package checks.
Local workerd checks exercise D1 behavior; they do not establish production deployment or authentication readiness.
