# Move existing Beads records into polylinedb

This procedure describes a one-time transfer of issue records into a new local polylinedb store.
It uses a converter for the source export, followed by the normal `pd import` operation.
polylinedb does not include a Beads importer or require Beads compatibility.
The converter must match the source version and the relationships present in that export.

Keep the source store until you have checked every destination record.
The transfer does not reproduce Dolt commits, branches, or merges.

## Capture the complete source

Pause writes from agents, hooks, and background processes that use the source store.
Use the installed source tool's read-only export operation.
Include closed issues, labels, notes, closure reasons, and relationship records.
Retrieve every issue's comments separately if the export omits them.
Follow every page when an operation returns paginated results.

Store the export, comments, converter, ID map, and verification results outside Git checkouts.
Use private file permissions for those artifacts.
Keep a backup of the original store as well as its export.
Review the content before moving it to another storage account.

## Choose the record mapping

Declare the destination project, tool, and prefix before assigning IDs.
Use a prefix that does not conflict with another store you plan to combine later.
Keep a complete map from each source ID to its destination ID.
New IDs use a prefix and a number, such as `parser-1`.
Children use the parent's ID plus a numeric suffix, such as `parser-1.1`.

Use these mappings as a starting point:

| Source information | Destination |
| --- | --- |
| Title, description, notes, and closure reason | One issue body with labeled sections |
| Source ID | The ID map and a searchable marker in the body |
| Issue type | `bug`, `task`, `epic`, `feature`, or `chore` |
| Status | `open`, `in_progress`, `deferred`, or `closed` |
| Priority and labels | The matching fields after validation |
| Parent-child relationship | A child ID suffix under an epic |
| Parent whose source type is not `epic` | Convert the parent to `epic` and record its original type in the body |
| Comment text and attribution | Comment records linked to the new issue ID |
| Creation and update timestamps | The corresponding audit fields |
| Missing author information | An explicit marker such as `migration:unknown` |

Do not infer an update author from the creation author.
Validate statuses, types, priorities, timestamps, and relationships instead of silently assigning defaults.
Inspect relationship records themselves. A summary count can omit parent-child edges.

polylinedb records issue prerequisites separately from epic containment.
Review an explicit mapping from source dependency endpoints to destination issue IDs before adding each edge through the dependency operation.
Keep the source direction explicit. The dependent points to its blocker.
Plaintext blocker notes require human review; migration tools do not parse them automatically.
Ready and blocked worklists evaluate current blocker statuses. Deferred issues remain postponed until an explicit status change.
See [issue prerequisites](prerequisites.md) for revisions, request receipts, and status exceptions.
Keep source fields without a dedicated destination field in the body or in a private accompanying archive.
If you include a complete source record in the body, it becomes readable by everyone allowed to use the destination store.

## Build a snapshot for an empty store

Use the installed CLI to create an empty rehearsal store and export the current snapshot format:

```sh
pd --data-dir /srv/private-transfer/rehearsal init
pd --data-dir /srv/private-transfer/rehearsal export \
  --file /srv/private-transfer/empty-snapshot.json
```

Replace these fictional paths with your own absolute paths outside Git checkouts.
The empty snapshot supplies the current format and schema version.
Your converter must produce a valid snapshot for that format.
Use the source checkout's snapshot validator to check the converted result.

Assign IDs deterministically and populate the corresponding root and child counters.
Initialize field versions to `1`. Those versions describe future polylinedb updates, not source history.
Preserve comment IDs where valid, or record their deterministic mapping too.
Do not invent creation receipts for source requests whose identities and inputs you cannot establish.
Keep memory collections empty unless the source contains knowledge with a separately reviewed mapping.

This conversion is an operator step, not a `pd` subcommand.
Review the converter against the complete captured export before importing its result.

## Rehearse and check every record

Import the converted snapshot into the empty rehearsal store:

```sh
pd --data-dir /srv/private-transfer/rehearsal --actor local:operator import \
  --file /srv/private-transfer/converted-snapshot.json
pd --data-dir /srv/private-transfer/rehearsal export \
  --file /srv/private-transfer/rehearsal-readback.json
```

Compare the complete readback with the converted snapshot.
Local import requires an explicit actor, like other local mutations.
The actor can come from `--actor`, `POLYLINEDB_ACTOR`, or repository defaults.
Imported creation and update authors remain the values from the snapshot.
For every source issue, check the body, status, type, priority, labels, timestamps, attribution, comments, and ID mapping.
Check every child against its mapped parent.
Read every list page and verify that the IDs have neither omissions nor duplicates.

Test normal operations in a disposable copy of the rehearsal store.
Check creation, comments, search, updates, close, and reopen with the installed CLI.
Confirm that an update with an old field version fails without changing the record.
Confirm that an exact import replay leaves the store unchanged.
After editing a record in the disposable copy, confirm that replaying the old snapshot is refused.

## Transfer knowledge from another tool

Issue bodies and project memory are separate collections.
For external knowledge without verifiable polylinedb creation receipts, leave the snapshot memory collections empty.
Create the reviewed knowledge after import with `pd memory create`:

```sh
pd --data-dir /srv/private-transfer/rehearsal --actor local:operator --prefix parser \
  memory create --project parser --title 'Build constraints' \
  --body-file /srv/private-transfer/knowledge.md --request-id REQUEST_UUID
```

Generate and retain a lowercase UUID before each logical creation.
Retry only with the same request ID and inputs.
The new entry records the migration time and the selected actor as its creation metadata.
Preserve the original timestamp and attribution in the body when needed.
For a polylinedb snapshot, retain its existing memory records and receipts instead of recreating them.

## Activate the checked destination

Import into a new, empty destination with the same explicit actor selection.
`pd import` does not merge into a populated store.
Repeat the complete readback comparison there.
Export the source again and compare it with the captured source before activation.
If the source changed, stop and repeat conversion and verification.
Repeat the reviewed external-knowledge creation steps in the final destination after its issue import.
Check each memory's title, body, project, and retained source metadata before activation.

Set the repository's defaults only after those checks pass:

```sh
pd --data-dir /srv/personal-issues init \
  --tool compiler \
  --project parser \
  --prefix parser \
  --actor local:owner
pd context
pd list --project parser
```

Use the same destination directory that you imported.
Repository defaults reside in Git metadata. The database stays outside the repository.
Change agent instructions and hooks to use `pd`, then stop the source's ordinary writers.
Keep the original store and private ID map for historical lookup.

Search a retained source ID with an explicit project filter:

```sh
pd search 'SOURCE_ID' --project parser
pd show DESTINATION_ID
```

A source ID can also appear in a child's relationship text, so use the ID map for an exact match.

## Move the checked store to Cloudflare

Verify the local conversion before a cloud transfer.
To restore into a new D1 database, follow the [snapshot restoration procedure](d1-migration.md).
To preserve an existing cloud store, follow the [shared-store cutover procedure](local-cloud-cutover.md).
The additive procedure requires disjoint keys and counter namespaces.
Changing a connection alone does not transfer records.
