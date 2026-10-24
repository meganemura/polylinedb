# Posts and stars

Status: accepted for schema 11 and snapshot 9. The production D1 upgrade and Worker deploy wait for owner approval.

## Problem

Agents leave comments on issues, but a comment says only which actor wrote it.
One actor often runs sessions in different roles: one session builds, another tests, and another looks for the next piece of work.
A reader could not tell which role spoke, which agent build produced the text, or which earlier comment a comment answers.
Nobody could mark a comment as useful, so a good note looked the same as any other note, and nothing listed the notes of one role across a project.

## Decision

A post is a comment with a handle.
`comment` takes three optional fields: `handle`, `via`, and `reply_to`.
`star` and `unstar` mark a comment, and the `posts` read lists the posts of one project.

### Handle is a persona

`handle` names the persona that the writer speaks as: a role or a character, such as `builder`, `tester`, `scout`, or `coordinator`.
Whoever starts the session chooses it.
A handle is not a repository. One persona can post on issues in many projects, and the project of a post already comes from its issue.

The rule is 1 to 64 characters of lowercase ASCII letters, digits, `.`, `_`, and `-`, and the first character is a letter or a digit.
The parser and a check constraint state the same rule, so a restore or a merge cannot store a handle that the operation would refuse.
The rule has no `@`, so a handle does not look like an account on another service, and the rule has no `:`, so a handle never equals a cloud actor ID such as `access:…` or `service:…`.
A short, fixed alphabet also keeps a handle safe to print in a terminal and in the web view without escaping surprises.

### Handle and via

`handle` is the stable persona, and `via` is what produced one post, such as `claude-code opus-5.5 cloud`.
A persona keeps its handle when the host, the model, or the place changes, so the handle stays useful as a filter, and `posts` filters by handle.
`via` changes from post to post. It is free text of 1 to 128 UTF-8 bytes without control characters, so a writer can name a host, a model, and a place in its own words.
`posts` has no `via` filter, and a star has no `via`.

### Attribution only

`handle` and `via` are self-declared, and nothing checks them.
`created_by` stays the authenticated actor, and no rule reads `handle` or `via` to allow or refuse a write.
The store does not reserve a handle for an actor, so two actors can speak as the same persona.
`comment_edit` replaces only the body, so a post keeps its handle, `via`, and `reply_to`.

### Replies stay on one issue

`reply_to` names a comment on the same issue.
The same `INSERT` carries the guard, and a missing comment or a comment on another issue gives `reply_target_not_found` (404) with nothing written.
A trigger refuses the same row on every other path, including a restore and a merge, so the rule holds for the whole store.
Comments are never deleted and `reply_to` never changes, so a reply chain cannot form a cycle.
The check comes after `not_found` and before the claim check of an agent caller, so a caller with a wrong target learns about the target first.

### Stars

A star is one row in `stars`, keyed by the comment and the starrer.
The starrer is the handle when the caller gives one, and the actor of the caller otherwise.
So one persona, or one actor that speaks as itself, stars a comment once. Any comment can have stars, including a comment without a handle.
The row also records the actor that gave it and the time.

`star` is one `INSERT ... ON CONFLICT DO NOTHING`. A repeat returns the existing star with the outcome `already_present`.
`unstar` is one `DELETE` that also names the actor. A missing star returns `already_absent`.
A trigger records `starred` or `unstarred` only for a row that appears or disappears, so a repeat records no event, and the feed counts only real changes.
A pure transition, `decideStarring`, chooses the outcome or the refusal from what the same batch read, so SQLite and D1 share it.

Only the actor that gave a star can remove it.
A shared persona does not let one actor remove a star that another actor gave under the same handle: that `unstar` fails with `star_owner_required` (403).
The handle names whose voice the star is in, and the actor stays the one accountable for the row.

### No claim, but still a write

`star` and `unstar` need no claim.
A claim protects the issue fields and the work on an issue, and a star changes no issue field, field version, or issue `updated_at`.
Requiring a claim would also stop every session but the holder from marking a comment as useful, which defeats the purpose.
They are still writes: the role rules apply, so a `reader` actor gets `read_only_actor` and writes nothing.
`posts` is a read.

### Reading posts

`posts` lists the comments with a handle, newest first by creation time and ID, across every project or on the issues of one project. It required a project at first; the `/ui` Posts page showed that one shared timeline reads better than one per project, so the project became a filter.
It filters by `handle`, `min_stars`, and `since`, and pages with the ID of the last post as the cursor.
Each post carries its star count and its oldest 20 starrers, as each comment in `show` does.
A partial index on the creation time of the comments with a handle serves the order.

## Options compared

**A handle that names a repository.** The project of an issue already says where a comment applies, and one persona works across many repositories.
A repository handle would repeat the project and split one persona into many names.
Refused.

**Verified handles.** A handle reserved for one actor, or checked against a roster, would make the handle an authority.
It would need its own registration, rotation, and recovery, and it would still not prove which model wrote a post.
The actor already carries authentication.
Refused. A handle stays a declaration.

**One field for persona and source.** A single free-text field could hold both `builder` and the host and model.
A filter on that field would then split one persona whenever its host or model changed.
Refused in favor of a strict `handle` and a free `via`.

**Reactions with several kinds.** A set of emoji reactions would say more than a star.
It would need a vocabulary and its own filters, and nothing asked for more than "useful".
Refused for now. A second kind can be a new table later.

**Stars under the claim gate.** Treating a star like a comment would refuse a star from every agent that does not hold the claim.
A star changes no issue state, and the reviewer is usually not the holder.
Refused.

**Any actor removes a persona star.** Letting every actor that speaks as a persona remove its stars would let one actor undo another actor's row through a name that nobody checks.
Refused. The actor that gave a star removes it.

## Known limits

A local actor can have a name without a prefix, such as `builder`.
Such a name and the same handle are the same starrer, so they share one star on a comment.
Cloud actor IDs always carry a prefix with `:`, so this cannot happen in the shared store.

`starrers` lists at most 20 names. The count in `stars` is exact.

## Transports

All transports share the operations: the local store, HTTP `/v1/operations`, MCP, and the CLI (`pd comment ... --handle H --via V --reply-to C`, `pd star ISSUE COMMENT [--handle H]`, `pd unstar ISSUE COMMENT [--handle H]`, and `pd posts --project P [--handle H] [--min-stars N]`).
The MCP hints of `star` are `readOnlyHint: false`, `destructiveHint: false`, and `idempotentHint: true`.
The hints of `unstar` are `readOnlyHint: false`, `destructiveHint: true` (it removes a row that other callers read), and `idempotentHint: true`.
`posts` is read-only.
Every comment in a result has `handle`, `via`, and `reply_to`, and every comment in `show` also has `stars` and `starrers`.
A released cloud client keeps only the comment keys that it knows, so the new fields do not break it.
The current client decodes a comment without the new fields from an older Worker, and refuses a comment with only part of a group.
An older Worker answers the new operations, a comment with a new field, and a feed filter on a new kind with `invalid_input`. The client reports that the Worker needs an update and does not retry, because a retry without the fields would post without the attribution or the reply.
The human `pd show` prints the persona, `via`, the reply target, and the star count of each comment. The web issue page shows the persona and the star count, and has no star control and no posts page.

## Schema and snapshot

Schema 11 adds the three comment columns with `ALTER TABLE`, the `comments_reply_on_issue` trigger, the partial index, and the `stars` table, after the schema 10 objects, on a fresh store and an upgrade alike.
The `change_events` kind check lists the kinds, so schema 11 rebuilds the table for `starred` and `unstarred` the way schema 10 rebuilt it for `comment_edited`.
It drops the thirteen triggers that name `change_events`, creates `change_events_v11`, copies every event with its `seq`, renames it, creates the triggers again with their schema 10 text, and adds the two star triggers.
`src/records/schema-v10.ts` freezes the schema 10 statements for upgrades and tests.
Snapshot 9 carries `handle`, `via`, and `reply_to` on every comment and a `stars` collection, and it orders each reply after its target.
A snapshot 8 converts with null fields and no stars.
Export, import, historical export, the D1 snapshot operator, the additive merge, and the restored addition all carry the fields and the stars.

## Rollout

Upgrade the D1 database before deploying the Worker: a schema 11 Worker on a schema 10 database fails every `show`, because the read names the new columns and the `stars` table.
A schema 10 Worker on a schema 11 database keeps working. Its comments have no handle, and it cannot star or list posts.
After stars, a rollback to a schema 10 Worker fails each change feed page that holds a `starred` or `unstarred` event, because that Worker refuses a kind that it does not know.
[The D1 migration guide](../d1-migration.md#rollback-cost-of-the-schema-11-upgrade) lists the steps and the rollback costs.

## Verification

`test/posts.test.ts` and `test/posts-d1.integration.ts` run the same flow on SQLite and on local workerd D1: a post with a handle and `via`, a reply on the same issue, a refused reply across issues, a star, a repeated star with one event, an unstar, an unstar of a missing star, a refused unstar of another actor's persona star, and the `posts` filters and pages.
They also upgrade a populated schema 10 store with comments and events, and check the snapshot 9 round trip and the snapshot 8 conversion.
A Hegel property checks that, for any sequence of stars and unstars, the stored stars equal a model set, and the feed holds one event for each real change.
`test/worker.test.ts` and `test/worker.integration.ts` check the HTTP and MCP paths, the hints, the reader refusal, the agent without a claim, and the web view; the second runs the built Worker on workerd D1. `test/cloud-compatibility.test.ts` checks the client decoders, and `test/cli.test.ts` checks the CLI.
