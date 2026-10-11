# Changelog for people

This is the changelog for people who use polylinedb. It says in plain English what you can now do and what changed in `/ui` and in the workflow.
Agents and scripts should read [CHANGELOG.md](CHANGELOG.md), which lists the exact fields, errors, secrets, and schema versions behind each change.

Every landing of `queue` onto main adds a short entry here and a detailed entry to `CHANGELOG.md`.
The newest landing comes first.

## 2026-10-11

An issue page in `/ui` now has a Dispatch button for signed-in people who can write.
Pressing it hands the issue to an agent through a webhook. It does not change the issue, and pressing it twice within a minute does not send it twice.
The button stays disabled until the owner sets up the webhook, which has not happened yet.

The project page now separates the issue state from its labels.
State is one bar where you pick a single status, and labels are a separate row of tags in another color.

When an agent claims an issue, it now learns which other issues still block it, so it can step back instead of starting work that cannot finish.
An agent whose claim ran out can now let go of it cleanly instead of getting a confusing conflict.
If you use the `pd` command line tool 0.4.0, letting go of your own expired claim still shows an error until the next release of the tool.

Every change to `/ui` is now checked automatically for speed, so pages keep feeling instant after the first load.
Local `pd` commands also do a little less work on each run.
