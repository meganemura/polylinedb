# Changelog for people

This is the changelog for people who use polylinedb. It says in plain English what you can now do and what changed in `/ui` and in the workflow.
Agents and scripts should read [CHANGELOG.md](CHANGELOG.md), which lists the exact fields, errors, secrets, and schema versions behind each change.

Each change adds a short entry under `## Unreleased` here, in the same commit as the change, and a detailed entry to `CHANGELOG.md`.
A release commit turns `## Unreleased` into a version section such as `## X.Y.Z (YYYY-MM-DD)`.
The dated landing entries below are history. Landings after 2026-10-12 add no entry of their own.

## Unreleased

You can check which server version is running before you use it.
The server reports its package version, build commit, and database version through MCP or an authenticated HTTP read.
A build without a known clean source commit reports an unknown commit.

Changes on `queue` or main that are not in a release yet.

You can now find work that was started but that nobody holds anymore. `pd list --status in_progress --claimed false` lists those issues, and `pd show --human` adds "(no active claim)" next to the status. The Working page in `/ui` has a new section, "Started without an active claim", with the same issues. Nothing changes the status by itself when a claim ends; these views only show where to look.

An issue can be marked in progress only by whoever holds its claim. This now applies to everyone, including the owner, and to issues that were never claimed. Without the claim, the change is refused and nothing is written. Epics are the exception and can be in progress without a claim. A new issue can no longer start in progress, unless it is an epic: create it open, claim it, then start it. Giving up a claim does not change the status, so set the issue back to open before you release it, or use the queue handoff, which does that for you.

If pd tools are missing on the first reply of a session, the guide now explains why and what to do: retry once, or give a local Claude Code more time to connect. The server also reports how long it spent on each MCP request, so a slow start can be traced.

An agent now hands finished work to the landing queue in one step instead of five. One call records the commit and a summary, marks the issue as waiting for main, and gives up the claim. Either everything is recorded or nothing is, so a crash no longer leaves an issue half handed over.

The packaged-server check now expects the in-place Dispatch script, so release checks pass again.

Pressing Dispatch no longer leaves the issue page. The button shows that it is sending, then a line under it says whether it was sent and when, and the notes box empties. If something goes wrong, the line says what happened and your notes stay.

A check that sometimes failed when the clock crossed a second during the test is now stable.

The Dispatch box on an issue page looks tidier, especially on an iPhone: a roomy notes box that does not zoom the page when you tap it, a large Dispatch button, and the start-now line right next to it.

The CLI now shows who closed an issue and when for a cloud connection too, once the cloud server is updated. Older CLIs keep working unchanged.

`/ui` has a new Activity page. It shows what happened most recently, including comments and claims that do not move an issue on Recent. Keep the link at the bottom to come back later and see only what happened since.

In `/ui`, Waiting for main and Recently closed rows now open the issue, and Working now rows show the issue ID. On the issue page, Dispatch has an optional box for notes to the agent, and one line above it says whether the issue can start now: whether it is ready, blocked, claimed, or waiting on you. The line does not stop you pressing.

Owner items in `/ui` now show what they ask for. An issue that starts with a line such as 要対応（owner-action） is listed under its next line, so the To do and To decide rows no longer all read the same. The issue page still shows the marker at the top of the text.

When an agent takes over an issue whose previous claim ran out without being released, it is now told who held it and when it expired, so it can pick up their pushed work instead of duplicating it. Agents that cannot keep their claim alive now hand over their work before the claim runs out.

The CLI module-loading test now runs without opening your computer's credential store.

Tests now stop before they start on an unsupported Node version. The message shows your Node version and the required range from the package.

The checks that run on every push finish sooner. They now run in parallel pieces instead of one long line, and every check still runs.

Landing work on main is quicker. A change now carries its own changelog lines, so moving it to main needs no extra commit and no extra round of checks, and the checks no longer run a second time on main for a commit that already passed them. The owner's landing agent may now land checked work on main without asking each time. Releases still wait for the owner's approval.

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
