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

Migrated bodies can refer to other issues by source ID, such as `duplicate of source-17`.
polylinedb does not resolve those references.
Choose one treatment for the whole transfer and apply it consistently:

- Rewrite each reference with the ID map. Keep the source ID beside the new ID, such as `parser-3 (source-17)`, so the original text stays traceable.
- Keep the source ID as written. Tell readers to run `pd search "Source ID: source-17"`, which finds the issue whose body carries that marker.

`pd search` matches the exact text, so use the same marker spelling in every migrated body.

Do not infer an update author from the creation author.
Validate statuses, types, priorities, timestamps, and relationships instead of silently assigning defaults.
Inspect relationship records themselves. A summary count can omit parent-child edges.

polylinedb records issue prerequisites separately from epic containment.
Review an explicit mapping from source dependency endpoints to destination issue IDs before adding each edge through the dependency operation.
Keep the source direction explicit. The dependent points to its blocker.
Plaintext blocker notes require human review; migration tools do not parse them automatically.
Every new issue starts at prerequisite revision 1, and each accepted add or remove raises it by one.
Revision 1 means that nobody has edited the prerequisites yet. It does not mean that the issue has no blockers.
A script that adds edges to issues it just created can pass `--expected-revision 1` for the first edge and the returned revision for the next one.
A `dependency_conflict` means that the expected revision is stale. Read the issue with `pd dependency list` and decide again.
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

### Check the source after activation

Continue complete source exports after the switch until old agent sessions, hooks, and background writers stop.
Retrieve all comments and follow every page, as in the initial capture.
Compare every field and comment with the captured baseline, including edits, status changes, and deletions.
Counts and new IDs alone do not detect changes to existing records.
Retain each capture, both stores' histories, and the updated ID map in the private archive.

Separate genuinely new source issues from changes to mapped records.
For mapped records, reconcile each changed field or comment deliberately against the destination's latest field versions.
Review source deletions against both histories before changing the destination.
Preserve destination work during reconciliation.
`pd import` accepts an empty store or an exact, unchanged replay.
It rejects a different snapshot in a populated store.
Do not replace the populated destination with a new conversion of the old source.

### Recover a new source issue

Check the ID map before each recovery.
Use `pd create` only for a genuinely new source issue without a destination mapping.
Search markers can match other bodies or comments. The ID map determines the corresponding destination record.
Review the source content for privacy before copying metadata or author details.
Retain the complete source record and comments in the private archive.
Map status, type, priority, labels, and parent relationships with the same rules as the original transfer.
For a child, recover its parent first and pass the mapped destination parent ID through `--parent`.

`pd create` allocates a new polylinedb ID.
Its native creation and update metadata record the recovery time and the recovery actor.
Keep the original source ID, timestamps, and authors in explicitly labeled body sections and the archive.
Preserve each original comment's source ID, timestamps, and authors in its copied text or the archive.
`pd comment` also records the recovery time and actor, rather than the original comment's audit metadata.
After an uncertain comment append, read the destination issue before deciding whether another append is needed.
Cloud mutations use the authenticated actor. Local mutations require an explicit local actor.

Generate and retain a lowercase request UUID before each logical issue creation.
Prepare and retain the exact body and field inputs before the request.
This fictional example recovers a root task with reviewed fields:

```sh
cat > /srv/private-transfer/late-issue.md <<'EOF'
# Add parser diagnostics

Report the source position for an invalid token.

## Original source metadata
Source ID: source-42
Created at: 2026-09-30T10:00:00.000Z
Created by: source:example-author
Updated at: 2026-09-30T11:00:00.000Z
Updated by: source:example-editor
EOF
pd --data-dir /srv/personal-issues --actor local:owner --prefix parser \
  create --tool compiler --project parser \
  --body-file /srv/private-transfer/late-issue.md \
  --status open --type task --priority 2 --label migration \
  --request-id REQUEST_UUID
```

Replace `REQUEST_UUID` with the retained UUID.
The example does not convert all source metadata or reproduce native source audit fields.
If the result is uncertain, retry with the same actor, request UUID, body, and field inputs.
Record the returned destination ID in the ID map.
Run `pd show` for that ID and compare every field and comment before recovering the next issue.

## Move the checked store to Cloudflare

Verify the local conversion before a cloud transfer.
To restore into a new D1 database, follow the [snapshot restoration procedure](d1-migration.md).
To preserve an existing cloud store, follow the [shared-store cutover procedure](local-cloud-cutover.md).
The additive procedure requires disjoint keys and counter namespaces.
Changing a connection alone does not transfer records.
