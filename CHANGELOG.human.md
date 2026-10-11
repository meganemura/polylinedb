# Changelog for people

This is the changelog for people who use polylinedb. It says in plain English what you can now do and what changed in `/ui` and in the workflow.
Agents and scripts should read [CHANGELOG.md](CHANGELOG.md), which lists the exact fields, errors, secrets, and schema versions behind each change.

Every landing of `queue` onto main adds a short entry here and a detailed entry to `CHANGELOG.md`.
The newest landing comes first.

## Unreleased

Enqueued on `queue` and not yet on main. Whoever lands `queue` moves these lines into that landing's entry.

## 2026-10-12, landing da88994

Version 0.5.2 finishes what 0.5.1 started. Version 0.5.1 reached npm, but the last step of the release, creating its tag and its GitHub Release, failed, so neither exists for 0.5.1. Version 0.5.2 fixes that step. The `pd` command itself works the same as in 0.5.1, so there is nothing to change when you move from 0.5.1 to 0.5.2.

This landing puts version 0.5.2 on main. That push starts the Publish workflow, which waits for the owner to approve it before anything reaches npm. No Worker was deployed.

## 2026-10-12, landing f6a4e41

Version 0.5.1 is the next `pd` release on npm. Version 0.5.0 was prepared but never published, so 0.5.1 brings everything listed for 0.5.0: the change feed, `pd wait`, owner waits, claim keepalive, issue close records, and the `/ui` fixes. Moving from 0.4.0 still means running `pd upgrade` on your local store and converting an older snapshot with `pd snapshot convert --from 5`.

Releases now start by themselves. When a change to the version in `package.json` reaches main, the Publish workflow tests the package, waits for the owner to approve, publishes it to npm, and then creates the tag and the GitHub Release. Nobody publishes or tags by hand any more. `docs/releasing.md` is the one guide for this.

This landing puts version 0.5.1 on main. That push starts the Publish workflow, which waits for the owner to approve it before anything reaches npm. No Worker was deployed.

## 2026-10-12, landing c543fb5

The `pd` command on main is now version 0.5.0, and the tag `v0.5.0` marks it. The package is not published to npm yet; that happens in a separate step the owner approves.
The 0.5.0 notes in `CHANGELOG.md` say how to move from 0.4.0: upgrade your local store with `pd upgrade`, and convert an older snapshot with `pd snapshot convert --from 5` before you import it.
No Worker was deployed in this landing.

## 2026-10-11, landing 55af219

The **Dispatch** button in `/ui` works again. Pressing it used to fail with "Origin is not allowed." because the page told the browser to hide where the request came from. `/ui` pages now share that only with the same site, so other sites still learn nothing, and requests from other sites are still refused. This takes effect after the next Worker deploy, which this landing does not do.

The changelogs and commit messages describe each change in words and no longer name pd issues, because only the owner's agents can open pd. A check on every push rejects a new commit message that names one. The link from a pd issue to its commits stays in pd.

## 2026-10-11, landing 5779921

An issue now remembers who closed it and when. Closing it again keeps that first close. Opening it again clears the memory. An issue that was already closed before this change has no close time, and a later edit is not used as one.

On a project page, **Recently closed** follows that close time. A recorded close shows who closed it. An issue with no close record stays below those and still shows its last edit.

The home page shows **Waiting on you** above the project list. Open issues that need a decision are under **To decide**. Open issues that need you to act are under **To do**. The inbox uses the same split and also lists work that is waiting to land.

Every `/ui` page shows a small icon in the browser tab. It is a line through a few points, in the same colors as the pages, with a darker version when the device uses a dark theme.

Issues that are waiting on the owner no longer appear as ready work. A separate list shows those issues and the work that is directly waiting on them.

You can ask `pd` to wait until a change you name has happened, or until a time limit you set runs out. The wait does not change the issue.

An agent can keep its claim while a long check runs. If the claim is lost and the agent asked to stop the check, `pd` waits until that check has actually exited.

The `pd` command in this tree can let go of your own expired claim without an error. The published `pd` 0.4.0 still reports an error for that case. This landing does not publish a new package.

The package list now includes a file that creating an issue loads. The next published package has to include that file, or `pd create` fails as soon as it starts. The published 0.4.0 package does not load the file, so it does not fail this way. This landing does not publish.

Agents that add work to the shared queue run the full test suite after they catch up with that branch. They stop only the processes they started.

This file says the landing in plain language. `CHANGELOG.md` lists the fields, the errors, and the commands.

This landing does not change the live database and does not deploy the Worker. Upgrade the database before you deploy the Worker. If you deploy first, closing an issue on the new Worker fails.

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
