---
name: polylinedb
description: Use the pd CLI to read and manage agent work in an existing local or cloud polylinedb issue store. Applies to issue discovery, progress comments, and authorized status or field changes.
---

# Agent issue workflow

Use `pd --help` for the installed CLI contract. Select the task's local or cloud connection deliberately.
Initialize or change stores only when the task requests setup.

## Select the work

Run `pd context` from the working repository before reading issues.
Check the selected mode, connection, data directory or cloud URL, project, prefix, and actor against the task.
Connection selection uses flags, then environment variables, repository defaults, the user default, and the legacy local directory.
Use either `--connection NAME` or `--data-dir PATH`. The matching environment variables are `POLYLINEDB_CONNECTION` and `POLYLINEDB_DATA_DIR`.
For a local actor, an explicit flag overrides an environment variable, which overrides repository defaults.
Prefix, tool, and project flags override repository defaults directly.
For cloud context, run `pd actor` to confirm the server's authenticated identity.
Cloud commands reject `--actor` and ignore inherited local actors.
If authentication is required, ask the user to complete `pd --connection NAME auth login` in their own browser.
Keep credentials and authorization URLs out of issue bodies, comments, and shared logs.
Do not switch to local storage to bypass a cloud failure.
Repository project and tool defaults apply to creation. They do not filter list or search.
With a shared store, use the task's project explicitly:

```sh
pd list --project PROJECT --status open
pd list --project PROJECT --status in_progress
pd search 'search text' --project PROJECT
pd show ISSUE_ID
```

Follow `next_cursor` with `--after` when the result has another page.
Read the selected issue and its comments before deciding what work it requires.
Before changing an issue, confirm that `issue.project` matches the task's authorized project.
Full IDs can select issues from any project in the shared store.
Use complete issue IDs when sharing commands between repositories.
Numeric IDs expand with the selected prefix; a prefix selects a numbering namespace, not a project filter.
Use supported list filters to find work. `pd` has no `ready`, `claim`, dependency, or memory command.
An `in_progress` status records progress; it does not establish exclusive ownership.

## Record progress

Local mutations require the task's authorized actor, supplied by repository defaults, `POLYLINEDB_ACTOR`, or `--actor`.
Cloud mutations use the authenticated actor. Omit `--actor` from the examples below when using a cloud connection.
The actor records attribution. It does not grant permission to change an issue.
Update only fields that the task authorizes. Use the versions returned by the latest `show`:

```sh
pd --actor ACTOR update ISSUE_ID --status in_progress --expect status=STATUS_VERSION
pd --actor ACTOR update ISSUE_ID --body-file ./issue-description.md --expect body=BODY_VERSION
pd --actor ACTOR comment ISSUE_ID --body 'Reproduced the failure and identified its cause.'
pd --actor ACTOR close ISSUE_ID --expected STATUS_VERSION
pd --actor ACTOR reopen ISSUE_ID --expected STATUS_VERSION
```

Replace each version placeholder with the current integer from `issue.versions`.
Each updated field needs its own `--expect FIELD=VERSION`.
Close and reopen check the status version.
On a conflict, read the issue again and decide whether the proposed change still applies.
Do not automatically replace expected versions and retry.
After completing authorized work, record the result and verification evidence before an authorized close.

Comments append to the record. They have no request ID for safe retries.
After an uncertain comment result, inspect the issue's comments before deciding whether another append is necessary.

## Create work

Create an issue only when the task authorizes it.
Use a body that states the problem or requested outcome and enough context for another agent.
Select the project, tool, prefix, and actor deliberately:

```sh
pd --prefix PREFIX --actor ACTOR create --tool TOOL --project PROJECT \
  --body-file ./issue-description.md --request-id REQUEST_UUID
```

For a cloud connection, omit `--actor`; the server supplies the identity.

Generate one UUID for each logical creation request and retain it before invoking the command.
After an uncertain result, reuse that UUID with identical arguments and actor.
Omitting `--request-id` generates a new UUID for each invocation and can create another issue on retry.
Use `--type epic` for a group of work and `--parent EPIC_ID` for its children.
Read the parent first and confirm that its project matches the child's authorized project.
Closing an epic leaves child statuses unchanged.

For additional fields and errors, use `pd --help` and the installed package's `docs/operations.md`.
