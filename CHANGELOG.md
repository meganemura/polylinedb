# Changelog for agents

This is the agent changelog. It records the behavior that an agent or an operator script depends on.
People should read [CHANGELOG.human.md](CHANGELOG.human.md), which says the same changes in plain English.

Each work commit adds its own entry under `## Unreleased` here and in `CHANGELOG.human.md`. A landing of `queue` onto main adds no entry and no commit.
An entry covers MCP and CLI behavior, new or changed return fields, error and no-op semantics, required Worker secrets and bindings by name, D1 schema versions and migrations, and deploy prerequisites.
Entries never contain secret values, tokens, account IDs, or webhook URLs.
Entries never name pd issue ids, because readers cannot open pd. Each entry describes the change in words.
A release commit turns `## Unreleased` into a version section.
The publish workflow reads a version section such as `## 0.4.0 (2026-10-09)` for the GitHub Release notes, so keep those headings.

## Main landings

This section is history. Landings up to 2026-10-12 added a commit with an entry here; later landings add none, and their changes are in `## Unreleased` and the version sections below.
Newest landing first.
Each landing is a `### YYYY-MM-DD main SHORT_SHA` heading, where the SHA is the newest landed commit below the changelog commit.
Each change under it is a `####` heading that names the change in words, and a list of `key: value` lines, so a search such as `grep -n '^- secrets:' CHANGELOG.md` finds it.
The keys are `commits`, `surface`, `change`, `fields`, `errors`, `compatibility`, `schema`, `secrets`, `deploy`, and `status`. A key that does not apply is left out.

### 2026-10-12 main da88994

- main: da88994c56f4ff9dcc5bec6b6e80a52ed0ed0d13
- previous main: 196b57e91d8e1927169453852a62d3bb4ab063bf
- landed commits: 9ed09fb, 79bf984, da88994
- schema: 8. This landing does not change D1.
- deploy: not done. No Worker deploy in this landing.
- cli: `package.json` is 0.5.2. The push of this landing to main changes `package.json`, so it starts the `Publish` workflow, which waits for the owner to approve the `publish` environment before npm publication. Version 0.5.1 is on npm without a tag or a GitHub Release.

#### Send gh api POST bodies in the release job

- commits: 9ed09fb test(release): pin that the gh client sends POST bodies with --input -; 79bf984 fix(release): send gh api POST bodies with --input -
- surface: `scripts/github-release.ts`, the `release` job of `.github/workflows/publish.yml`.
- change: `gh api` reads a request body from standard input only with `--input -`. The client now passes it for every POST, so the annotated tag, its ref, and the GitHub Release are created with their bodies. GET requests are unchanged. A test runs the client against a stand-in `gh` and checks each call's arguments and body.
- errors: before the fix, GitHub answered the tag POST with HTTP 422 and the `release` job failed after npm publication.
- compatibility: `ghClient` is exported for the test. No CLI, Worker, or schema change.
- schema: none.

#### Prepare the 0.5.2 release

- commits: da88994 release: prepare polylinedb 0.5.2
- surface: `package.json`, `package-lock.json`, MCP `initialize` `serverInfo.version`, `CHANGELOG.md`, `CHANGELOG.human.md`, `docs/releasing.md`.
- change: the package version and `serverInfo.version` are 0.5.2. `## 0.5.2 (2026-10-12)` says 0.5.1 reached npm without a tag or a GitHub Release and that 0.5.2 carries the release job fix with the same CLI and Worker, and adds an upgrade note from 0.5.1.
- schema: 8. Snapshot 6. No change in this landing.
- deploy: npm publication after the owner approves the `publish` environment. Worker deployment stays a separate step.

### 2026-10-12 main f6a4e41

- main: f6a4e41a8f2e1236f97785b19506be4963789239
- previous main: 1c52b67e9bcf36c21e185fedaad83eb84b3e07e0
- landed commits: a2a2c26, 2f44fea, f6a4e41
- schema: 8. This landing does not change D1.
- deploy: not done. No Worker deploy in this landing.
- cli: `package.json` is 0.5.1. The push of this landing to main changes `package.json`, so it starts the `Publish` workflow, which waits for the owner to approve the `publish` environment before npm publication. Version 0.5.0 was never published and has no tag.

#### Release automatically when a push to main changes the version

- commits: a2a2c26 ci(publish): release automatically when a push to main changes the version
- surface: `.github/workflows/publish.yml`, `scripts/release-version.ts`, `scripts/npm-release.ts`, `scripts/github-release.ts`.
- change: the `Publish` workflow runs on a push to `main` that changes `package.json`; `workflow_dispatch` and its `version` and `commit` inputs are gone. Job `check` (`contents: read`) requires an `X.Y.Z` version in `package.json` equal to both lockfile versions and outputs `tag` and `version` only when `git ls-remote --exit-code --tags origin refs/tags/v<version>` finds nothing. Job `publish` (`needs: check`, environment `publish`, `contents: read` and `id-token: write`) runs every earlier verification step on the pushed commit, publishes the tested tarball, and verifies the registry integrity. Job `release` (`needs: [check, publish]`, `contents: write`) writes the notes and creates the annotated tag and the GitHub Release on `GITHUB_SHA`. The workflow default is `permissions: {}`, and the `npm-publish` concurrency group does not cancel a running release.
- errors: `check` fails when a lockfile version differs from `package.json` or when the tag lookup fails. On a re-run, `publish` skips `npm publish` only when the registry already has the version with the tarball's integrity, and fails when it has a different tarball. `scripts/github-release.ts` now takes the commit from `GITHUB_SHA` and no longer reads `APPROVED_COMMIT`.
- compatibility: the npm trusted publisher stays bound to the `publish.yml` filename and the `publish` environment. A push that changes `package.json` to a version that already has a tag releases nothing.
- schema: none.
- deploy: none. The workflow never deploys the Worker.

#### docs/releasing.md is the single release guide

- commits: 2f44fea docs(release): make docs/releasing.md the single release guide
- surface: `docs/releasing.md`, `CLAUDE.md`, both queue skill copies.
- change: the guide covers cutting a release through `queue`, the three workflow jobs, who approves and who may tag or publish, re-runs and recovery, and the separation of CLI releases from Worker and D1 changes. `CLAUDE.md` and the queue skill link to it. Tests pin the guide's statements about the workflow.
- schema: none.

#### Prepare the 0.5.1 release

- commits: f6a4e41 release: prepare polylinedb 0.5.1
- surface: `package.json`, `package-lock.json`, MCP `initialize` `serverInfo.version`, `CHANGELOG.md`, `CHANGELOG.human.md`.
- change: the package version and `serverInfo.version` are 0.5.1. `## 0.5.1 (2026-10-12)` says 0.5.0 was never published and that 0.5.1 carries the 0.5.0 changes plus the release automation, and repeats the upgrade from 0.4.0 guidance. The 0.5.0 section stays.
- schema: 8. Snapshot 6. No change in this landing.
- deploy: npm publication after the owner approves the `publish` environment. Worker deployment and the D1 upgrade stay separate steps.

### 2026-10-12 main c543fb5

- main: c543fb5e634ab4b64e8252d7d80a3705c2cab78f
- previous main: a797df837109f670d46678ca015e2ca980ff0bbb
- landed commits: c543fb5
- schema: 8. This landing does not change D1.
- deploy: not done. No Worker deploy in this landing.
- cli: `package.json` is 0.5.0. No npm publish in this landing. The annotated tag `v0.5.0` marks this landing's main tip.

#### Prepare the 0.5.0 release

- commits: c543fb5 release: prepare polylinedb 0.5.0
- surface: `package.json`, `package-lock.json`, MCP `initialize` `serverInfo.version`, `CHANGELOG.md` release sections, `docs/releasing.md`.
- change: the package version and the MCP `serverInfo.version` are 0.5.0. The former `## Unreleased` section is now `## 0.5.0 (2026-10-12)`, and an empty `## Unreleased` section sits above it. Its `### Upgrade from 0.4.0` subsection is now the last part of the 0.5.0 section, so `scripts/release-notes.ts` includes it in the release notes. It states that 0.5.0 uses schema 8 and snapshot 6, that a local store needs `pd upgrade`, that a 0.4.0 snapshot needs `pd snapshot convert --from 5`, and how the 0.5.0 CLI and a 0.4.0 Worker work together.
- compatibility: the publish workflow's version checks pass for 0.5.0: the manifest and both lockfile versions match, and the release notes section is not empty.
- schema: 8. Snapshot 6. No change in this landing.
- deploy: npm publication is a separate, owner-approved run of `publish.yml`. Worker deployment and the D1 upgrade stay separate steps.

### 2026-10-11 main 55af219

- main: 55af2190d3e7c97a9fd1aa6ad60eafbc9acfd11b
- previous main: fe52b3cac067f61f5ce0164caa14f5ca8fe94de2
- landed commits: c6cae06, 8c45333, 55af219
- schema: 8. This landing does not change D1.
- deploy: not done. No Worker deploy in this landing. The `/ui` Referrer-Policy change takes effect on the next Worker deploy.
- cli: `package.json` stays 0.4.0. No npm publish in this landing.

#### /ui pages send Referrer-Policy same-origin, so Dispatch works

- commits: 8c45333 fix(ui): send /ui pages with Referrer-Policy same-origin so Dispatch works
- surface: Worker `/ui` pages, including their `304 Not Modified` answers, and the Dispatch form POST to `/ui/i/<id>/dispatch`.
- change: `/ui` pages send `Referrer-Policy: same-origin` instead of `no-referrer`. Under `no-referrer`, browsers sent `Origin: null` on the same-origin Dispatch POST, so every press failed with 403 `forbidden_origin`. The POST now carries the page's real origin, and cross-origin requests still get no referrer. The speculation-rules prefetch keeps `referrer_policy: "no-referrer"`, because a prefetch is a GET that dispatch does not see.
- errors: the dispatch origin check is unchanged. It accepts only a missing `Origin` or the request's own origin. `Origin: null` stays 403 `forbidden_origin`, also when `ALLOWED_ORIGINS` lists `"null"`.
- schema: none.
- secrets: none new. Dispatch still needs `POLYLINEDB_DISPATCH_WEBHOOK_URL` and `POLYLINEDB_DISPATCH_WEBHOOK_KEY`.
- deploy: Worker deploy. This landing does not deploy. No D1 migration.

#### No pd issue ids in the changelogs

- commits: c6cae06 docs(changelog): remove pd issue ids and forbid them in the changelog rules
- surface: `CHANGELOG.md`, `CHANGELOG.human.md`, both queue skill copies, `docs/agent-workflow.md`, `docs/claims.md`, `docs/releasing.md`.
- change: landing headings and `## Unreleased` lines describe changes in words, and the `issue` key is gone. `test/release-notes.test.ts` fails when either changelog names a pd issue id, and `test/skill-contract.test.ts` fails when the two queue skill copies drift apart.
- schema: none.

#### No pd issue ids in commit messages

- commits: 55af219 docs(workflow): keep pd issue ids out of commit messages and check pushed ranges
- surface: `CLAUDE.md`, both queue skill copies, `docs/agent-workflow.md`, `scripts/commit-messages.ts`, and the new `commit-messages` job in `.github/workflows/check.yml`.
- change: commit messages describe the change in words and never name a pd issue id. The `tip:` comment on the pd issue links it to git. The job runs on push and pull request with full history. It checks the commits from `github.event.before` to `github.sha`, or from the pull request base to its head. A new branch, or a `before` commit that the clone lacks, checks the pushed tip alone. History before the pushed range is not checked. No git hook is added.
- errors: the job fails and prints each offending commit with the ids it names.
- schema: none.
- deploy: none.

### 2026-10-11 main 5779921

- main: 5779921cb92c697f2478ecfd681eaf645cb79624
- previous main: 748c720332b925c8c89618868d7e43e722c950b3
- landed commits: c44204e, 9b56052, 6b4e3a8, f1aefdd, 1ce0048, 2b68b03, 6ec16e9, 4c08fe9, 4921dbc, e323f9d, 8d3238a, e985279, e9f8b29, 9475535, 6a25b3d, b795077, 5415cae, 182e2af, bcfa445, a09b209, f4017f8, 4434696, f0ca165, 46e3d2a, f01e320, fbfbe34, 5779921
- reverted: 6b4e3a8 added a Claude Code allow rule for pd MCP tools, and f1aefdd removed it. The rule is not in the tree.
- schema: 8. This landing does not change D1. Upgrade D1 before deploying the Worker.
- deploy: not done. No Worker deploy in this landing.
- cli: `package.json` stays 0.4.0. No npm publish in this landing.

#### Schema 8 records closed_at and closed_by

- commits: e985279 feat(schema): freeze the schema 7 reference; e9f8b29 refactor(service): keep released issue rows on /v1/operations; 9475535 feat(schema): store issue closure in schema 8 and snapshot 6; 6a25b3d feat(records): record who closed an issue and when; b795077 feat(cli): show the closure in human issue details; 5415cae test(closure): restore and verify closures through the D1 operator; 182e2af docs: record the issue closure decision and the schema 8 procedures; a09b209 fix(records): type owner-wait rows with the closure columns
- surface: local SQLite, D1, MCP issue results, `pd show --human`, snapshot 6, `pd upgrade`, `pd snapshot convert --from 5`, `pd export --historical`. HTTP `/v1/operations` omits the new fields.
- fields: local results and MCP add `closed_at` and `closed_by` on each issue. Both are null while the issue is not closed, and for an issue closed before schema 8. A status change into `closed`, forced or not, sets them to the write time and the actor, so `closed_at` equals the new `updated_at`. A creation with status `closed` sets them to the creation time and the creator. Closing an issue that is already closed keeps the first closure. Reopen and any other status change away from `closed` clear them. Other edits keep them. `/v1/operations` success and error bodies omit both keys, so a released cloud CLI still reads the same issue shape. `pd show --human` prints `Closed <time> by <actor>` only when a closure is recorded.
- errors: the column check allows both columns null, or both nonempty text with status `closed`. A schema 8 Worker on a schema 7 database reads issues, and every status change and every creation with status `closed` fails, because those writes name the new columns.
- compatibility: the upgrade leaves `closed_at` and `closed_by` null on existing issues, including closed ones. It does not copy `updated_at`. The change feed still records a close as `status_changed` with `fields: ["status"]`. Snapshot 6 carries both fields. `pd snapshot convert --from 5` fills null closures. `pd upgrade` accepts canonical schemas 2 through 7. `pd export --historical` reads schemas 6 and 7. An installed CLI that predates schema 8 refuses an upgraded local store with `unsupported_schema`. CLI 0.4.0 is that CLI.
- schema: 8. Schema 7 is frozen. Snapshot 6.
- deploy: upgrade D1 before deploying the Worker. For a database that already has the change feed, run `node scripts/schema.ts --upgrade-from 7` and apply that batch. See `docs/d1-migration.md`. A schema 7 Worker keeps working on schema 8 and writes no closure. After a schema 8 Worker closes issues, rolling the Worker back makes reopen fail on those issues. This landing does not change D1 and does not deploy.
- status: the closure issue stays open until the owner closes it. No production migration in this landing.

#### Attention and Waiting on you

- commits: 46e3d2a Add one Attention read for owner and main-wait issues; f01e320 Show Waiting on you above the project list
- surface: Worker `/ui` home and `/ui/inbox`. No MCP tool and no CLI command.
- change: home shows **Waiting on you** above the project list. It lists open issues labeled `owner-decision` or `owner-action`, across projects. `owner-decision` is under **To decide**, and `owner-action` is under **To do**. An issue with both labels is under **To decide** only. Each group is higher priority first, then the issue that has waited longest. The wait is counted from `created_at`, because the store does not record when a label was added. Each row shows the first line of the body, the issue id, the project, and the wait, and opens the issue. The section lists only `open` issues. It counts deferred and in-progress owner issues and links to the inbox for them. The read stops at 100 issues and the page says when more exist. The inbox lists every not-closed issue the same rule selects, including `main-wait`, newest first, at most 50.
- schema: none.
- deploy: Worker deploy. This landing does not deploy. No D1 migration.

#### /ui favicon

- commits: 4434696 Add an inline SVG favicon to every /ui page
- surface: Worker `/ui`, every page.
- change: the page head uses an inline SVG `data:` URI instead of an empty icon. The icon is a polyline in the page colors, with a night variant for `prefers-color-scheme: dark`. It adds no request. The existing `img-src data:` policy allows it. The Content-Security-Policy, caching, and prefetch rules are unchanged.
- schema: none.
- deploy: Worker deploy. This landing does not deploy.

#### Recently closed order

- commits: bcfa445 feat(ui): order recently closed issues by closed_at
- surface: Worker `/ui` project page, **Recently closed**.
- change: the list orders by `closed_at` descending, then by the last update. A recorded close shows that time and `closed_by`. An issue with no close record sorts after the recorded closes and shows its last update, which is not the close time. An edit after the close does not move a recorded close. The `closed` chip still orders the filtered list by last update.
- schema: none of its own. The queries read the schema 8 closure columns above.
- deploy: the same Worker deploy as the schema 8 closure change, and only after that D1 upgrade. This landing does not deploy.

#### Claim keepalive

- commits: 2b68b03 Add pd claim keepalive to renew a lease during long checks; f4017f8 Wait for the command to exit when pd claim keepalive kills it on loss
- surface: local and cloud CLI `pd claim keepalive`. It calls the existing `claim_show` and `claim_renew` operations. No new Worker route.
- change: `pd claim keepalive --claim-proof JSON [--ttl 30..3600] [--max-duration 1..28800] [--kill-on-loss] (--pid PID | -- COMMAND ...)` renews until the command or process exits. It renews at once, then one third of the TTL before each deadline. `--max-duration` defaults to 7200 seconds and is capped at 28800. The exit code is the command's code, 0 when the watched pid exits or the claim is released, 5 with `claim_lost`, or 6 with `keepalive_max_duration`. It refuses an issue labeled `main-lock`. `--kill-on-loss` sends SIGTERM and waits for the command to exit, then SIGKILL after 5 seconds, so the command is gone when `claim_lost` is reported. Without that flag the command keeps running.
- errors: three renewal conflicts in a row from the same session stop it with the store error. A lost claim exits 5. The duration bound exits 6.
- compatibility: no Worker or schema change. Cloud agents still renew through MCP `claim_renew` and do not log the CLI in with owner credentials.
- schema: none.

#### Wait polling

- commits: 4921dbc feat(wait): poll the change feed until a match or a timeout
- surface: `pd wait`, HTTP `wait`, read-only MCP `wait`. Local SQLite and D1.
- fields: same page as `changes`, at most 50 matching events. `wait` has no `limit`. `since` and `timeout` are required. `timeout` is seconds and has no default. A match that is already present returns that page without waiting. A timeout returns no events and the current `next_since` and `incarnation`.
- errors: the feed errors are unchanged. `incarnation_mismatch` and `cursor_expired` are 409. `since` past the newest `seq` is `invalid_input`.
- compatibility: the call writes nothing. The Worker and the local CLI reread the feed about once a second. A timeout of N seconds with no match reads the feed N + 1 times. That count is not a D1 bill. An older Worker answers `invalid_input` for the unknown operation.
- schema: none. It reads the schema 7 change feed.
- deploy: Worker deploy before cloud `pd wait` works. This landing does not deploy.

#### Owner-wait worklist

- commits: 4c08fe9 feat(worklist): keep owner waits off the ready worklist and list them
- surface: `dependency_worklist` with `state: "ready"`, `pd ready`, new `dependency_owner_waits`, `pd owner-waits`. Local SQLite and D1.
- fields: `dependency_owner_waits` returns unfinished issues labeled `owner-decision` or `owner-action`, in id order. Each entry has `issue`, `dependents` (`id`, `project`, `status`, at most 50, in id order), and `dependents_next` (the last returned dependent id when more exist, otherwise null). Filters are `tool`, `project`, `after`, and `limit` 1..100, default 50.
- change: the ready worklist leaves out `owner-decision` and `owner-action` for every actor, as it already did for `main-lock`. Naming one of those labels in the filter does not bring the issue back. `main-wait` is not an owner wait and stays on the ready worklist. The claim gate still checks only the `ready` label.
- errors: an older Worker answers `invalid_input` for `dependency_owner_waits`.
- compatibility: no schema change. The change feed is unchanged. An issue that carries both `ready` and an owner label leaves the ready worklist after deploy. A claim an agent already holds stays until release or expiry. a09b209 teaches the owner-wait row type the schema 8 closure columns. It adds no migration.
- schema: none.
- deploy: Worker deploy. This landing does not deploy.

#### Expired-release opt-in and decode

- commits: 9b56052 fix(claims): make the expired-lease release no-op opt-in; e323f9d test(cloud): expect the deployed expired-release no-op to decode; 8d3238a fix(cloud-client): decode the deployed expired-release no-op
- surface: MCP `claim_release`, HTTP `/v1/operations`, `pd claim release`, the cloud client. Local SQLite and D1.
- fields: a request opts in with `expired_noop: true`. `pd claim release` always sends it. When the proof names the caller's expired lease, the result is `{ released: false, current }` and `current.state` is `expired`. The revision stays the same, `released_at` stays null, and the store writes no receipt. A stale `expected_revision` still succeeds.
- errors: without `expired_noop`, the store keeps `claim_conflict`. A proof for a different session or generation still returns `claim_conflict`, including when that newer lease is expired. A Worker that does not know the field rejects it with `invalid_input` and writes nothing.
- compatibility: the cloud client sends the release once more without the field, with the same request UUID. An older Worker answers `claim_conflict`, and the CLI reports that code. A Worker that answers `{ released: false, current }` for the plain release is decoded as the no-op when `current` is the expired lease the proof names. Production still does that, because main 748c720 deployed the no-op as the default and this landing does not deploy the opt-in. Published CLI 0.4.0 still decodes a release success only as `claim_receipt`, so `pd claim release` of an expired own lease still gets `cloud_invalid_response` until the next npm publish. The optional `open_blockers` decode is already on main 748c720. These commits do not change it.
- schema: none.
- deploy: Worker deploy before production requires `expired_noop`. This landing does not deploy.
- status: the opt-in and decode issues stay open until the owner closes them.

#### Packed attention.js

- commits: fbfbe34 Expect the packed CLI to include dist/records/attention.js; 5779921 Include dist/records/attention.js in the packed CLI
- surface: the npm package file list. `src/records/index.ts` loads `dist/records/attention.js`.
- change: `package.json` `files` includes `dist/records/attention.js`. A pack that omits it makes `pd create` exit 1 with `internal_error` and `ERR_MODULE_NOT_FOUND` instead of exit 2 `invalid_input`. Tag v0.4.0 does not load that module, so the published 0.4.0 package is not this failure.
- schema: none.
- deploy: none. No npm publish in this landing.

#### Queue skill checks and own-PID kills

- commits: f0ca165 Require a post-rebase full suite and own-PID kills in the queue skill
- surface: the polylinedb-queue skill, both copies. No code, schema, or Worker change.
- change: after the final rebase onto `queue`, and again after a rejected push, the agent runs the full test suite on the rebased commits before pushing `queue`. Test counts in the enqueue record come only from that run. A failure on the queue tip blocks the push. The agent kills only PIDs it started. It does not use `pkill -f`, `killall`, or `kill` on a `pgrep` list. `.github/workflows/check.yml` already runs on every push, including `queue`.
- schema: none.

#### Queue is the agent landing path

- commits: c44204e Make the queue branch the agent landing path in the skills; 1ce0048 Align the leftover agent docs with the queue branch
- surface: agent skills and `docs/agent-actors.md`, `docs/claims.md`. No runtime change.
- change: agents branch from the `queue` tip, may push `work/<issue id>` without force, and push `queue` without force. A rejected push is fetch, rebase, and push again. After an enqueue the issue goes back to `open` with `main-wait`, and the claim is released. The owner lands `queue` onto main and closes the issue. Agents do not push main and do not take `main-lock`. If the claim expires after the queue push, the agent acquires the issue again and then writes the tip comment.
- schema: none.

#### Changelog split

- commits: 6ec16e9 Split the changelog into an agent file and a human file
- surface: `CHANGELOG.md`, `CHANGELOG.human.md`, the queue skill, `docs/claims.md`, `docs/agent-workflow.md`, `docs/releasing.md`. `CHANGELOG.human.md` is in the npm `files` list.
- change: `CHANGELOG.md` is the agent changelog. `CHANGELOG.human.md` is the plain-language changelog. The 748c720 landing entry was backfilled in this commit. Release headings below `## Main landings` stay, because the publish workflow reads them. No MCP, CLI, schema, or Worker behavior changes in this commit.
- schema: none.

### 2026-10-11 main 748c720

- main: 748c720332b925c8c89618868d7e43e722c950b3
- previous main: b2cc155b9d27ef9956415d4c9196e753b3716cc7
- landed commits: 0ca6ee3, 16559b9, f96674a, fb2dc4c, 0ac391f, b42eb1e, 5a46448, 67d829e, f1d7b97, 0bd5d1d, a0eaef8, 5737f02, 2f285db, bf686c0, 748c720
- check: GitHub Check run 38116804370 passed on all 4 jobs
- schema: 7, unchanged. No D1 migration.
- deploy: production Worker version 2af3e77f, deployed after the landing. D1 was confirmed at schema 7 before the deploy.
- cli: the latest npm CLI is still 0.4.0. No CLI release in this landing.

#### Dispatch from the /ui issue page

- commits: 2f285db feat(ui): post a dispatch envelope from an issue page; bf686c0 docs: explain how to set the dispatch webhook secrets; 748c720 test(dispatch): wait until the overlapping press fetch starts
- surface: Worker `/ui`, new route `POST /ui/i/<id>/dispatch`. Every other `/ui` page stays `GET` only.
- change: the issue page shows one Dispatch button to an Access human with write access, whose actor id starts with `access:`. A press POSTs one Sink `intent: dispatch` envelope to the configured webhook. The envelope carries `project`, `issue_id`, `event_id`, `idempotency_key` (`<issue_id>:dispatch`), and `occurred_at`. A press does not change the issue.
- errors: a reader, an agent, a service actor, and an anonymous request are refused and see no button. The POST accepts a missing `Origin` or the Worker origin, and ignores `ALLOWED_ORIGINS`.
- fields: none in MCP or CLI responses.
- compatibility: a repeat for the same project and issue within 60 seconds reuses the `event_id` and does not POST again after a success. The window is in memory on one isolate, so another isolate or an eviction can deliver again. A failed delivery retries the same `event_id` until the window ends.
- schema: none.
- secrets: `POLYLINEDB_DISPATCH_WEBHOOK_URL` and `POLYLINEDB_DISPATCH_WEBHOOK_KEY`, both Worker secrets, both or neither. `cloudflare.config.ts` does not declare them, so a deploy without them succeeds and the button is disabled with `Dispatch is not set up.`
- deploy: set both secrets with `cf workers secrets bulk`, then confirm that a later `cf deploy` keeps both names. See `docs/cloud.md`, "Set the dispatch webhook".
- status: production Worker version 2af3e77f has neither secret, so Dispatch sends nothing yet. The Dispatch issue stays open for the end-to-end press.

#### claim_acquire reports open blockers

- commits: 0ac391f test(claims): expect open blockers on claim acquisition; b42eb1e feat(claims): report open blockers when a claim is acquired; 5a46448 test(cloud): decode claim_acquire when open_blockers is absent; 67d829e test(claims): pin active blockers to the worklists for each status; f1d7b97 refactor(records): use one active-blocker predicate
- surface: MCP `claim_acquire`, HTTP `/v1/operations`, `pd claim acquire`, local SQLite and D1.
- fields: a `claim_acquire` success returns `{ claim_receipt, open_blockers }`. `open_blockers` holds the ids of active blockers (any status other than `closed`, so a deferred blocker counts), in issue order, as observed at acquire time. It is `[]` when there are none. A replay reads the list again. Renew and release keep `{ claim_receipt }`.
- errors: acquire never fails because of blockers.
- compatibility: CLI 0.4.0 and later accept the field. CLI 0.3.1 reports `cloud_invalid_response` on `pd claim acquire` against this Worker, although the claim is acquired. The cloud client returns no `open_blockers` key when an older Worker omits it. MCP clients are not affected.
- agent rule: if `open_blockers` is non-empty and the claim was meant to start work, release it and pick another ready issue.
- schema: none.
- deploy: Worker deploy, done on production Worker version 2af3e77f.

#### Release of an expired own lease is a no-op

- commits: f96674a test(claims): expect a no-op release for an expired own lease; fb2dc4c fix(claims): release an expired own lease as a no-op
- surface: MCP `claim_release`, HTTP `/v1/operations`, `pd claim release`, local SQLite and D1.
- fields: when the proof names the current expired lease (same actor, session, and generation), `claim_release` returns `{ released: false, current }`, where `current.state` is `expired`. The revision stays the same, `released_at` stays null, and the store writes no receipt. A stale `expected_revision` still succeeds.
- errors: a proof for a different session or generation still returns `claim_conflict` with an unchanged revision, also when that newer lease is expired. Writes under an expired lease still need a new acquisition.
- compatibility: on main 748c720 and production Worker version 2af3e77f the no-op answer is the default. CLI 0.4.0 decodes a release success only as `claim_receipt`, so `pd claim release` of an expired own lease gets 502 `cloud_invalid_response` against the production Worker instead of 409 `claim_conflict`, until the next CLI release. MCP callers are not affected. The release already failed before this change. Queue commit 9b56052 makes the no-op opt-in with `expired_noop: true`; see `## Unreleased`.
- schema: none.
- deploy: Worker deploy, done on production Worker version 2af3e77f. Follow-up: the expired-release opt-in and decode above.

#### /ui latency budget gate in CI

- commits: a0eaef8 test(ui): fail CI when a /ui step misses the latency budget
- surface: `npm run check:ui-latency` (`scripts/ui-latency-budget.ts`), run by `.github/workflows/check.yml` on every push and pull request.
- change: a followed `/ui` link after the first load fails above 100 ms, and back or forward fails above one frame (16 ms). The tolerance is 0 ms. Chrome paint stays a manual measurement with `scripts/ui-latency.ts`.
- agent rule: a budget miss fails the change. A feature that cannot meet the budget needs an owner decision. See `docs/ui-latency.md` and `docs/agent-workflow.md`.
- schema: none.

#### Change feed defect injection

- commits: 5737f02 test(feed): fail the change feed contract on injected defects
- surface: `test/change-feed-defects.test.ts`, `docs/verification.md`.
- change: the change feed contract test fails on a store that drops one committed event and on a store that records an event for a rejected create. No runtime change.
- status: the defect injection issue stays open. The interleaving model and cold reconciliation harnesses are not in the repository yet.

#### /ui project state and marks

- commits: 0ca6ee3 feat(ui): separate project state from marks
- surface: Worker `/ui` project page.
- change: the status filters are one joined State bar with one status at a time; Unfinished means every status except `closed`. Label filters are a separate Mark row. The two use different colors. The operation API does not change.

#### Workspace Git cache

- commits: 16559b9 perf(workspace): reuse one Git repository answer per directory; 0bd5d1d docs: record CLI workload timings
- surface: local CLI only.
- change: a local command starts Git once per directory and reuses the answer, including "not a repository", for repository defaults, the configuration path, and external-directory checks. A failed Git start is not cached. See `docs/adr/0017-repository-lookup-cache.md` and `docs/performance.md`.
- compatibility: no output or flag changes.

## Unreleased

- New write `post` (local, HTTP, MCP, cloud client, and `pd post`) takes `project`, `body`, `handle`, and optional `via` and `reply_to`, and returns `{ comment }`. It writes the post to the project's timeline: the issue of that project labeled `timeline` (earliest by `created_at` then ID). The first `post` creates it with `create`: type `chore`, priority 4, status `closed`, labels `["timeline"]`, the prefix and `tool` of the project's newest issue, and a request ID that is a name-based UUID (SHA-256) of the project, so concurrent first posts create one issue; a caller that meets another actor's request reads the existing timeline. Neither `post` nor its timeline creation needs a claim, also for an agent; `comment` on the timeline keeps the claim gate. A project with no issue is `not_found` (404, details `{ project }`), with nothing written. `reply_to` must name a comment on the timeline; otherwise `reply_target_not_found` (404, details `{ id: <timeline id>, reply_to }`). `handle` is required. MCP hints: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`; a `reader` gets `read_only_actor`. The first post records `created` and `commented` on the timeline issue, later posts `commented`. CLI: `pd post --handle H --body TEXT [--project NAME] [--via TEXT] [--reply-to COMMENT_ID]` (or `--body-file`), project from repository defaults. The cloud client checks the echoed body and voice and the new `not_found` details, and reports `invalid_input` asking for a newer Worker, without a retry, when an older Worker rejects `post`. Skill: "Post what you learned" now says to post whenever a lesson turns up, with `post` and no issue, and to use `comment` only to tie a post to a held issue. No schema change, no new secrets or bindings; deploy the Worker to use `post` in the cloud.
- Test only: nukadoko 0.22.0 (exact dev pin, was 0.18.0). 0.22.0 refuses a Then step that runs code, so the two Thens of `features/stale-write.feature` declare `claims` instead. The conflict Then claims that the agent's `pd update` exit code means `conflict` by the table in `docs/operations.md` (the rewrite steps now return `exit`, the code's name in that table), that `error.code` is `conflict`, that every entry of `error.details.fields` is `body`, and that the first entry goes from the version the agent read to the version the other actor wrote. The kept-body Then reads `pd show` in `observe` and claims the body and `updated_by` against what the other actor's step returned (its `actor`, `body`, and `bodyVersion`). The other actor's step now fails unless its update exits 0, which the old Then checked. No sentence changed. `nukadoko.config.ts` and `npm run test:scenarios` do not change. No runtime change.
- Internal: the record code moves into one directory per record kind under `src/records/`: `store/` (row decoding, the SQL port, issue ids, errors, the read catalog, and the change log SQL), `claims/`, `resources/`, `issues/`, `dependencies/`, `land-order/`, `posts/`, `memories/`, `changes/`, and `persistence/` (the schema, its frozen versions, and snapshots). `records/index.ts` and `records/persistence/persistence.ts` are the public entries, and export the same names as before. `archstrict.config.ts` declares each directory as a module whose files only other records files may import, and a `records` order rule ranks them store, claims, domain, persistence, operations; `npm run check:architecture` adds controls for an outside import of a private schema file, a domain importing a sibling domain, and the store importing claims. `npm run solarsql` reads and writes `src/records/store/`. The npm package ships the same modules at the new `dist/records/` paths. The Stryker ranges follow the code they covered, including the row decoding now in `store/issue-record.ts`. MCP, CLI, D1 schema, and deploy are unchanged.
- Internal: issue and comment row decoding, and the issue field parsers, moved from `src/records/issues.ts` to `src/records/issue-record.ts`; the `SqlExecutor` and `SqlStatement` storage port moved to `src/records/sql.ts`. Record files read `statuses`, `issueTypes`, and `fields` from the transition module instead of `schema.ts`, which no longer re-exports them. The `records/index.ts` and `records/persistence.ts` exports are unchanged. Before this, claim handoff imported the issue command file and every domain file imported the schema that imports its own SQL, so the files formed two import cycles.
- Development: pin `archstrict` 0.6.0 (was 0.2.1). `archstrict check` and `npm run check:architecture` pass with no config change; 0.6.0 resolves the package imports (`solarsql`, `vite`, `miniflare`, `@cloudflare/vite-plugin`) that 0.2.1 left unresolved, so the `env:portable -> pkg` and `env:worker -> pkg` allowDeny rules evaluate 3 and 2 real edges instead of none.
- /ui: a page outside the four lanes (Projects, a project, an issue, Search, Activity, New issue, Posts, and a refused write) reads only the attention, started-without-claim, and blocked queries for its Today and Stuck badges, instead of all eight lane reads. Today, Agents, Landing, Stuck, and any page with a `done` flash still read every lane. The badge counts are unchanged; a test checks they match Today on each page. No MCP, CLI, schema, or deploy prerequisite change.
- `scripts/ui-latency.ts` runs again: the seed creates in_progress issues open and moves them after the claims (the store refuses a new issue that starts in_progress), a Chrome that exits at start fails with its stderr instead of hanging, and links scroll into view at once because the pages scroll smoothly. `docs/ui-latency.md` Results now hold same-machine numbers for the lanes pages and the pre-lanes pages: the lanes pages take about three times the Worker time and two to four times the HTML. No runtime change.
- /ui: `/ui/new` can start a project. The project select ends with **New project…** (value `new`, selected when no project exists), which shows the fields `new.tool`, `new.project`, and `new.prefix`; CSS shows them only while that option is chosen, so the page still has one fixed script. `POST /ui/new` with `project=new` runs `create` with the typed prefix. An empty field, or a prefix outside `^[a-z][a-z0-9]{0,15}$`, answers 400; a project that already has issues under another prefix answers 400 and names that prefix. A refusal keeps the typed fields and the text. A project with no issue chosen any other way now says to choose New project. No MCP, CLI, schema, or deploy prerequisite change.
- `posts`: `project` is optional. Without it the read lists posts across every project, newest first, with the same filters and cursor. The MCP input schema no longer requires `project`. `pd posts` still fills `--project` from the repository default, and lists every project when neither is set. /ui: Posts is a top tab (six tabs; Agents is back to Now and Feed). It shows every project by default and names each post's project; the project and persona filters are selects, the persona list holding the handles that have posted, most posts first, at most 100. No schema change.
- Skill: `skills/polylinedb/SKILL.md` gains "Post what you learned": after each finished issue, one `comment` with `handle` (the brief's persona, else `builder` for code changes and `scout` for reading) and `via`, written while the claim is held and before `claim_handoff` or `close`; read `posts` with `min_stars: 1` before similar work, and `star` a post that helped. No secrets, credentials, private paths, or private-source text; no post when there is no lesson. No CLI, MCP, Worker, or schema change.
- /ui: new `/ui/posts` page (the Posts tab under Agents) reads `posts` for one project: query `project` (default: the project with the newest issue update), `handle`, `min_stars` (a whole number, else a sentence on the page), and `after`; 50 per page with an **Older posts** link. A bad filter shows the read's sentence instead of a 4xx. New write `POST /ui/i/<id>/star` with `comment` and `star=add|remove` runs `star` or `unstar` as the signed-in actor with no handle; a reader gets 403; any other `star` value is 400; `star_owner_required` reads "Only the one who gave a star can remove it." The form is a plain POST that answers 303 to its `return` path. A handle's face is its first letter on one of eight colors chosen by an FNV-1a hash of the handle; nothing is stored. No MCP, CLI, schema, or deploy prerequisite change.
- Add posts and stars (local, HTTP, MCP, and the CLI). `comment` takes optional `handle`, `via`, and `reply_to`. `handle` is a self-declared persona (1 to 64 characters of lowercase ASCII letters, digits, `.`, `_`, and `-`, starting with a letter or digit; also a check constraint), `via` is free text naming what produced one post (1 to 128 UTF-8 bytes, no control characters, not whitespace-only), and both are attribution only: `created_by` stays the authenticated actor and no rule reads them. `reply_to` must name a comment on the same issue; otherwise `reply_target_not_found` (404, details `{ id, reply_to }`), checked after `not_found` and before an agent's `claim_required`, with nothing written; a trigger enforces the same rule on restore and merge paths. `comment_edit` changes only the body. New `star` and `unstar` take `id`, `comment_id`, and optional `handle`, and return `{ star, outcome }`; a star is `{ comment_id, starrer, handle, actor, created_at }`, and the starrer is the handle when given, else the actor, so one starrer stars a comment once. `star` outcomes are `added` and `already_present` (a repeat returns the existing star); `unstar` outcomes are `removed` and `already_absent` (`star: null`). Only the actor that gave a star removes it: `star_owner_required` (403, details `{ id, comment_id, starrer }`) when another actor gave the star under the same handle. A missing comment on the issue is `comment_not_found` (404, details `{ id, comment_id }`), and a missing issue keeps `not_found`. Neither operation needs a claim, because a star changes no issue field or version; both are writes, so a `reader` gets `read_only_actor`. New read `posts` takes `project`, optional `handle`, `min_stars` (default 0), `since` (ISO 8601 instant with a time zone, or `YYYY-MM-DD` as midnight UTC), `after` (comment ID cursor), and `limit` (1 to 100, default 50), and returns `{ posts, next_cursor }` with the comments that have a handle on that project's issues, newest first by `created_at` then ID; a cursor that names no comment gives an empty page. Every comment in `show` and in `posts` gains `stars` (count) and `starrers` (the oldest 20, by star time then name); every comment in a result gains `handle`, `via`, and `reply_to` (null when omitted), and write results carry no star fields. The change feed adds `starred` and `unstarred` (`fields: []`, `issue_id` is the comment's issue), recorded only when a star row appears or disappears, and `changes` and `wait` accept them in `kinds` (now 1 through 12). MCP hints: `star` `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`; `unstar` `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`; `posts` read-only. CLI: `pd comment ID --body TEXT [--handle H] [--via TEXT] [--reply-to COMMENT_ID]`, `pd star ID COMMENT_ID [--handle H]`, `pd unstar ID COMMENT_ID [--handle H]`, and `pd posts [--project NAME] [--handle H] [--min-stars N] [--since TIME] [--after COMMENT_ID] [--limit N]` (project from repository defaults when omitted; `--after` does not expand with the prefix); exit code 3 for `comment_not_found` and `reply_target_not_found`, 1 for `star_owner_required`. `pd show --human` prints ` · as HANDLE`, ` · via VIA`, ` · reply to ID`, and ` · N stars` after a comment heading; `/ui/i/<id>` shows `as HANDLE` and the star count beside a comment, with no star control and no new page. Released cloud clients drop the new comment fields. The cloud client decodes a comment with each new group (`handle`/`via`/`reply_to`, `stars`/`starrers`) whole or absent (an older Worker), checks the echoed voice of a `comment`, the outcome, comment, and handle of a star, the order, filters, and cursor of a `posts` page, and the new error details, and reports `invalid_input` with a message that asks for a newer Worker, without a retry, when an older Worker rejects the new operations, a comment field, or a star kind. schema: 11 (adds `comments.handle`, `comments.via`, and `comments.reply_to` with check constraints and a foreign key, the `comments_reply_on_issue` trigger, the partial index `comments_posts`, and the `stars` table keyed by `(comment_id, starrer)`; rebuilds `change_events` for the two kinds while every event keeps its `seq`, recreates the thirteen triggers that name it with their schema 10 text, and adds two star triggers); `src/records/schema-v10.ts` freezes schema 10, `node scripts/schema.ts --upgrade-from 10` emits the D1 migration, and `pd upgrade` upgrades a local schema 2 through 10 store. Snapshot 9 adds the three fields to every comment and a `stars` collection, and orders each reply after its target; `pd snapshot convert --from 8` converts snapshot 8 with null fields and no stars, and `pd export --historical` reads schema 10. The D1 snapshot operator, the additive merge, and the restored addition carry them. deploy: apply the schema 11 D1 migration before the Worker deploy; a schema 11 Worker on a schema 10 database fails every `show` and `comment`. After stars, a schema 10 Worker fails each change feed page that holds a `starred` or `unstarred` event. No new secrets or bindings. See `docs/adr/0023-posts-and-stars.md`.
- CLI: `pd claim keepalive` exits when the claim is released or lost while a spared command keeps running. A released lease is read again for 5 seconds. Another generation in that window is exit 5 with `claim_lost`. A lease that stays released is exit 0, and the process no longer waits for the spared command. `--kill-on-loss` still applies only to `claim_lost`. No MCP, Worker, schema, or deploy change. No migration.
- CLI: `pd claim keepalive` still renews one third of the TTL before each deadline. A backward wall clock during the renew call, or a receipt whose `expires_at` is further ahead than the requested TTL, no longer stretches that wait past `(ttl - lead)` seconds. Negative elapsed time counts as zero. An ordinary receipt keeps the same schedule. A lost claim is still exit 5 with `claim_lost` while the command is running, including when the command is spared. No MCP, Worker, schema, or deploy change. No migration.
- Tests: pin `@hegeldev/hegel` 0.4.10 (was 0.4.7). That release includes the 0.4.9 libhegel bump from 0.42.4 to 0.45.4. On Node 26.12.1, libhegel 0.42.4 reports a shrunk port-protocol counterexample as flaky when those bytes still violate the model, so the Check unit jobs on Node 26.12.1 fail. 0.4.10 was published on 2026-10-14 and had been available for eight days. No CLI, MCP, Worker, schema, or deploy change. No migration.
- CI: the Check matrix is Node 24.22.1 and Node 26.12.1 on Ubuntu 24.04 and Ubuntu 26.04. The `commit-messages` job and every `setup-node` step in the Publish workflow use Node 24.22.1. Node 24.20.0 and Node 26.7.0 have a high-severity out-of-bounds write in the Brotli decoder and high-severity TLS hostname-check bypasses, fixed in 24.22.1 and 26.12.1 (2026-10-20 and 2026-10-21). `engines.node` stays `^24.20.0 || >=26.7.0`. The README wrapper example names Node 24.22.1, and `docs/verification.md` names the same Check pair. Dated measurements stay on the versions that produced them. No CLI, MCP, Worker, schema, or deploy change. No migration.
- Docs only: `docs/dependencies.md` lists vite 8.3.4, published 2026-10-08, and records the current overrides `@modelcontextprotocol/sdk` 1.32.1 and hono 4.13.13. The October 9 selection of SDK 1.31.0 stays as history. `test/dependency-record.test.ts` fails when the vite row or either current override sentence disagrees with `package.json`. No CLI, MCP, Worker, or schema change. No migration.
- Docs only: `docs/memory.md` now says `pd upgrade` takes a canonical schema 2, 3, 4, 5, 6, 7, 8, or 9 store to schema 10 in one transaction, and that `pd snapshot convert` writes snapshot 8, which is the only snapshot `pd import` accepts. `docs/local-cloud-cutover.md` requires canonical schema 10 on the Worker and both stores, which is the schema `scripts/d1-cutover.ts` checks. `docs/claims.md` names the current source as schema 10 and snapshot 8. Sentences about schema 8 and snapshot 6 stay, and they name versions 0.5.0 through 0.5.2. `test/operator-docs.test.ts` fails if the upgrade page again stops at schema 5, the cutover page again requires canonical schema 8, or the claim page again calls schema 8 current. The number it expects is `SCHEMA_VERSION`. No CLI, MCP, Worker, or schema change. No migration.

## 0.6.0 (2026-10-22)

Version 0.6.0 adds comment edits, external resources on an issue, land order between issues, `claim_handoff`, `previous_lease` on `claim_acquire`, the rule that `in_progress` needs a held claim, the `/ui` lanes design with write forms, the Worker version read, the solarsql 0.8.0 runtime check, and development dependency updates so `npm audit` passes. It uses schema 10 and snapshot 8.

- Dev dependencies only: pin vite 8.3.4 (was 8.3.1) and override `@modelcontextprotocol/sdk` to 1.32.1 (was 1.31.0, pulled in by archstrict) and hono to 4.13.13 (was 4.13.9), so `npm audit` in the `publish` job of the Publish workflow reports no vulnerabilities. The lockfile picks up the rolldown, postcss, and nanoid versions that vite 8.3.4 requires. The published package, its only runtime dependency solarsql, the CLI, the Worker, and the schema do not change.
- Replace the `/ui` views with the lanes design and add write forms. Pages: `/ui` (Today: a rule-composed brief, the lanes You, Agents, Landing, and Stuck, and Since yesterday), `/ui/agents`, `/ui/activity`, `/ui/landing`, `/ui/stuck`, `/ui/projects`, `/ui/p/<tool>/<project>` (`status`, `label`), `/ui/search?q=`, `/ui/new` (`?project=<tool>%0A<project>`), and `/ui/i/<id>`. `/ui/inbox`, `/ui/working`, `/ui/blocked`, and `/ui/recent` answer `301` to `/ui`, `/ui/agents`, `/ui/stuck`, and `/ui/activity`; any other `/ui` path keeps the JSON `404 not_found`. Every page reads the lane queries for its tab counts in the same parallel wave as its own reads. Roles: `human` sees every control, `agent` sees the write forms but no Dispatch, and `reader` sees no write form and gets `403` on every write. New POST routes, all `application/x-www-form-urlencoded`, at most 256 KiB (Dispatch keeps 16 KiB), with the same-origin rule of Dispatch (a missing `Origin` or the request's own; `ALLOWED_ORIGINS` does not apply): `/ui/i/<id>/decide` (`outcome` = `approve`|`decline`|`defer`, `note`, `dispatch=1`), `/done` (`outcome` = `done`|`defer`|`handback`, `note`), `/comment` (`body`), `/comment-edit` (`comment`, `body`, `v.comment`), `/status` (`open`|`deferred`|`closed`), `/priority`, `/type`, `/body`, `/labels` (repeated `labels`, `labels.new`), `/blockers/add` and `/blockers/remove` (`blocker`), `/land-order` (`op` = `set`|`clear`, `after`), `/ui/new` (`project`, `body`, `type`, `priority`, `labels`, `parent`, `then=dispatch`), and `/ui/landing/landed` (repeated `landed`). Each form carries the field versions it read as `v.<field>` and the values as `seen.<field>`, plus a `return` path. Each route builds plain operations and runs them through `parseOperation` and `executeOperation` as the caller; no new operation exists. Approve removes `owner-decision` and adds `ready`, decline closes, defer sets `deferred`, handback removes `owner-action` and adds `ready`; a note is then a comment (`Approved. NOTE`, `Declined. NOTE`, `Deferred. NOTE`). Mark landed removes `main-wait` and comments `Landed on main.` per issue; it does not check main. `/ui/new` takes the id prefix from the project's newest issue, so a project with no issue cannot be created there. A status write on an issue that was ever claimed acquires a 30-second claim labeled `pd ui`, updates under its proof, and releases it (`expired_noop: true`), so the claim history and the change feed record that lease; a live claim by another actor answers `422` with nothing written. A stale `labels` version is applied to the current list with the current version when no concurrent change touched a label in the form's diff. Answers: success is `303` to the validated `return` (must start with `/ui`, no `//`, backslash, or control character; otherwise the issue page), with `?done=<kind>:<id>` (`approved`, `declined`, `deferred`, `done`, `handedback`, `dispatched`, `opened`, `closed`, `created`) on decide, done, status, Dispatch, and create; `409` only for a stale field version, with the issue page and a conflict card (seen, now, the change, the result, the last `updated_by` and `updated_at`, the note kept, and a resend form with the current versions); `400`, `403`, `404`, or `422` with a page for every other refusal (a Dispatch conflict is `422` under JSON); `500` when the note comment fails after the update, with the note kept. When `Accept` lists `application/json`, every write answers `{ ok, message }` with the same status. The `Content-Security-Policy` now hashes the speculation rules and one page script (`pageScript`, which sends any `form[data-send]` by `fetch`, arms a second tap on `data-confirm`, and resends natively on `409`); `style-src 'unsafe-inline'`, `connect-src 'self'`, and `form-action 'self'` stay. `Server-Timing` is on writes too. A stored time that does not parse renders as an unknown time instead of a `500`. `scripts/ui-latency-budget.ts` and `scripts/ui-latency.ts` walk the new pages. No schema change, no new operation, and no new secrets or bindings; one new read query counts the last day's change events per actor and kind for the Since yesterday line, and the blocked, active-claim, and started-without-claim queries return the blocker ids, the holder's latest note, and the totals the lanes need.
- Docs only: `docs/bun-runtime.md` adds Linux measurements (Ubuntu 24.04, x86_64, 2026-10-20). Bun 1.4.3 runs `node:sqlite` and `bun:sqlite` on SQLite 3.53.4 with the same `sqlite_source_id()` as Node 24.20.0, and solarsql's runtime contract probe gives the same answers on both. Bun 1.4.2 on Linux runs 3.53.2. The CLI still refuses Bun 1.4.3 by name with `unsupported_runtime` (`details.actual_sqlite` 3.53.4). The next steps now name solarsql ADR 0145's condition for admitting Bun. No runtime change.
- Docs only: `README.ja.md` is a Japanese translation of `README.md`, and `README.md` ends with a link to it. Commands, code blocks, and links to `docs/` are the same in both. npm packs `README.ja.md` beside `README.md`, so the package gains that one file, and `scripts/test-package.ts` expects it. No runtime change.
- Add `comment_edit` (local, HTTP, MCP, and `pd comment edit ISSUE COMMENT_ID --expected N --body TEXT|--body-file PATH`). It takes `id`, `comment_id` (UUID), `body` (the `comment` limits), `expected` (the comment version from `show`), and optional `observed_memory_revision`, and returns `{ comment }`. Only the author edits: another actor gets `comment_author_required` (403, details `{ id, comment_id }`, never the body). An agent also needs its own active claim, as for `comment` (`claim_required`). The write is one conditional `UPDATE` on `version`: a stale `expected` gets `comment_conflict` (409, details `{ comment, expected }`), the maximum safe integer gets `comment_version_exhausted` (409, details `{ comment }`), a missing comment gets `comment_not_found` (404, details `{ id, comment_id }`), and a missing issue keeps `not_found` with its details. Two writers with the same version produce one accepted edit. Every comment in a result (`show`, `comment`, `claim_handoff`, `comment_edit`) gains `version` (from 1), `updated_at`, and `updated_by` (both `null` until the first edit; the editor is always the author). The store keeps no earlier body, and search finds only the new text; snapshots, D1 Time Travel, and backups made before an edit still hold the old text. An edit leaves issue fields, field versions, and the issue `updated_at` unchanged. The change feed adds the kind `comment_edited` (`fields: []`), and `changes` and `wait` accept it in `kinds` (now 1 through 10). MCP hints: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`. CLI exit codes: 3 for `comment_not_found`, 4 for the two 409 errors, 1 for `comment_author_required`. `pd show --human` prints ` · version N` after each comment heading and ` · edited TIME by ACTOR` after an edited one; `/ui/i/<id>` marks an edited comment with its edit time and has no edit control. Released cloud clients drop the three new comment fields. The cloud client decodes a comment with all three fields or none (an older Worker), refuses a partial set, a version 1 comment with an editor, and an editor other than the author, checks the echoed IDs, body, and version of a `comment_edit` result and its error details, and reports `invalid_input` with a message that asks for a newer Worker, without a retry, when an older Worker rejects `comment_edit`. schema: 10 (adds `comments.version`, `comments.updated_at`, and `comments.updated_by` with a check constraint, rebuilds `change_events` to accept the new kind while every event keeps its `seq`, recreates the triggers that name `change_events` with their schema 9 text, and adds the `comments_change_update` trigger); `src/records/schema-v9.ts` freezes schema 9, `node scripts/schema.ts --upgrade-from 9` emits the D1 migration, and `pd upgrade` upgrades a local schema 2 through 9 store. Snapshot 8 adds the three fields to every comment; `pd snapshot convert --from 7` converts snapshot 7 with version 1 and null editor fields, and `pd export --historical` reads schema 9. The D1 snapshot operator, the additive merge, and the restored addition carry the fields; the restored addition also accepts a snapshot 7 original. deploy: apply the schema 10 D1 migration before the Worker deploy; a schema 10 Worker on a schema 9 database fails every `show`. After edits, a schema 9 Worker fails each change feed page that holds a `comment_edited` event. No new secrets or bindings. See `docs/adr/0022-comment-edits.md`.
- Test only: `test/port-protocol.test.ts` runs an interleaving model of the port protocol for a per-issue split (`test/fixtures/port-protocol.ts`, checks and driver in `test/fixtures/port-protocol-check.ts`). It imports nothing from `src/`. Hegel draws 60-step schedules at seed 20261019 with 100 cases (`PD_HEGEL_CASES` overrides) over requests, admission and answer messages that can be lost, repeated, or delayed, row deliveries, timeouts, resets, age-outs, creations, edges, port rotations, stale routing, and first-touch pulls. After every step the property checks that each fact the current port relies on (its mirror, an open close answer, or a child) holds at the issue authority of record, that no claim or creation request ID has two receipts in any incarnation, and that each committed close finds its blockers closed. It also requires every event in `mustReach` and no age-out of a sequence the authority never admitted. Five injections, each one replaced rule, fail with the expected report: a restrictive change committed at the authority first, an abort row that releases any reservation, a rotated port that still admits, an object built from a receipt that names another incarnation, and the pin removed. The pin is a rule the model found: an open close admission makes the port refuse a reopen of the dependent's blockers and an edge to an open blocker. `docs/issue-authority.md` lists it as rule 8 with the readings of rules 1, 2, and 7 the model needed, and the split stays gated on a measured request rate. `docs/verification.md` records the runtime, cases to first failure, and shrunk trace lengths. `npm run test:properties` includes the property. No runtime change.
- Test only: nukadoko 0.18.0 (exact dev pin, was 0.17.0). The scenario uses none of the surfaces 0.18.0 removed, so the steps, `nukadoko.config.ts`, and `npm run test:scenarios` do not change. Each run now writes `.nukadoko/runs/<run_id>/`, which `.gitignore` already covers. The lockfile drops nukadoko's optional `@modelcontextprotocol/client` peer. No runtime change.
- Test only: nukadoko 0.17.0 (exact dev pin, was 0.14.0). The scenario steps use its built-in `scratch` fixture instead of a project fixture, so `nukadoko.config.ts` is `defineConfig({})`, and run `src/cli.ts` through its `runCommand` instead of `spawnSync`, so each step record lists the `pd` processes it started. The empty `returns` and `return {}` of the two Then steps are gone, and each step's `rationale` (a field 0.17.0 removed) is a comment above `defineStep`. `npm run test:scenarios` is `nuka run`, which runs the static check first. nukadoko no longer installs `playwright` or `tsx`, and the scenario needs neither. No runtime change.
- Adopt solarsql 0.8.0 (exact pin, was 0.7.1) and follow its runtime check in the CLI bootstrap. Every command other than help and `--version` now also fails with `unsupported_runtime` (exit 1, nothing written, `init` and cloud commands included) when `process.versions.bun` or `process.versions.deno` is set, whatever Node version that runtime reports, and when `node:sqlite` runs a SQLite older than 3.53.4 or reports no version. The checks run in solarsql's order: runtime name, then the `engines.node` range (unchanged, `^24.20.0 || >=26.7.0`), then the SQLite build. `details` gains `runtime` (`node`, `bun`, or `deno`), `runtime_version`, and `required_sqlite` (`3.53.4`) on every refusal, and `actual_sqlite` (a version string or `null`) on the name and SQLite refusals; `actual_node`, `required_node`, and `package_version` are unchanged. The Node range refusal keeps its message; the other two name the runtime or the SQLite version. `openStore` maps solarsql's `UnsupportedRuntimeError` (`code: "UNSUPPORTED_RUNTIME"`) to `unsupported_runtime` (status 500, details `{ solarsql_code: "UNSUPPORTED_RUNTIME" }`) instead of `internal_error` with that diagnostic code. The generated SQL is unchanged. The Worker and D1 paths do not run this check and do not change. No schema change.
- Test only: `features/stale-write.feature` runs the stale-write refusal as a nukadoko scenario. Two local actors read the same body version; the second `update --expect body=V` exits 4 with `conflict` naming `body V->V+1`, and `show` keeps the first actor's body. `npm run test:scenarios` runs `nuka check` and `nuka run features`, and the Check workflow runs it in the unit suite. nukadoko 0.14.0 is a new exact dev dependency. No runtime change.
- Add external resources on an issue (local, HTTP, MCP, and `pd resource add|update|list|live`). `resource_add` takes `issue_id`, `kind` (`^[a-z0-9][a-z0-9:._-]{0,63}$`), `name` (1 to 256 UTF-8 bytes, no whitespace or control characters), `expected_revision`, and `request_id`, and returns `{ resource_receipt: { issue_id, seq, revision, outcome: "added" } }`; the entry starts `planned`. `resource_update` takes `issue_id`, `seq`, `expected_revision`, `request_id`, and `external_id` (set once, same rules as `name`), `mark` (`created`, `deleted`, `verified_deleted`), or both, and returns `outcome: "updated"`. Marks move forward only (`planned` to `created` to `deleted` to `verified_deleted`, or `planned` to `verified_deleted`), each set once with the store clock. `verified_deleted` needs `evidence` (at most 1024 UTF-8 bytes) and a current `claim_proof` from every actor. `resource_list` returns `{ issue_id, revision, resources }` with each entry's columns and derived `state`; `resource_live` (`tool`, `project`, `after`, `limit`) returns `{ entries: [{ issue: { id, project, status }, resources }], next_cursor }` for issues with entries that are not `verified_deleted`. Errors: `invalid_input` for a field outside its rules, `resource_conflict` (409, details `{ expected_revision, current }`), `resource_request_conflict` (409), `resource_version_exhausted` (409, details `{ issue_id }`), `resource_mark_rejected` (409, details `{ resource }`), `not_found` with `{ id }`, and `claim_required` with `{ id }` for an agent without its claim or a `verified_deleted` without a held proof. `close`, and `update` to `closed`, now fail with the new code `resources_remaining` (409, no details) while the issue has an entry that is not `verified_deleted`; the message names up to five entries as `kind:name`. A nonempty `resources_reason` on `close` or `update` (`pd close|update --resources-reason TEXT`) closes anyway and stores the reason as a comment by the closing actor in the same write; `force` does not bypass the check, and an epic answers only for its own entries. On `resources_remaining` the CLI reads `resource_list` and reports the remaining entries in `details.resources`. Released cloud clients decode `resources_remaining` as an error without details. The cloud client does not retry when an older Worker rejects `resources_reason` or a resource operation; it reports `invalid_input` with a message that asks for a newer Worker. The change feed records `updated` with `fields: ["resources"]` for each committed entry change. schema: 9 (adds `issue_resources`, `resource_revisions`, `resource_requests` and their triggers in the same schema 9 migration as land order); snapshot 7 adds the three collections, and a snapshot 6 converts with empty ones. deploy: apply the schema 9 D1 migration before the Worker deploy; a schema 9 Worker on a schema 8 database fails every `update`, `close`, and `reopen`. No new secrets or bindings.
- Add land order (local, HTTP, MCP, and `pd land-order add|remove|list`). `land_order_add` and `land_order_remove` take `later_id`, `earlier_id`, `expected_revision`, and `request_id` and return `{ land_order_receipt: { later_id, earlier_id, revision, outcome } }`, where `outcome` is `added`, `already_present`, `removed`, or `already_absent`. The revision belongs to `later_id` and starts at 1. `land_order_list` takes `issue_id` and returns `{ issue_id, revision, after, before }`, each side a list of `{ id, project, status }` sorted by ID. Errors: `land_order_conflict` (409, details `{ expected_revision, current }`), `land_order_request_conflict` (409), `land_order_version_exhausted` (409, details `{ later_id }`), `not_found` with `{ id }`, and `dependency_cycle` (409) for a self-edge or any cycle through prerequisites, land order, or both; `dependency_add` now refuses a cycle through land order too. An agent needs its own active claim on `later_id`, or gets `claim_required` with `{ id }`. Land order never blocks start, claim, or close and does not change the ready or blocked worklists. `show` and `list` accept `with_land_order: true` (`pd show|list --with-land-order`) and then add `land_order`, an object for `show` and a list aligned with `issues` for `list`; default responses are unchanged. The cloud client retries without the flag when an older Worker rejects it, and then returns no `land_order`. `pd show --human` prints `Lands after: <id> (<status>), ...`. `claim_handoff` adds `land_order_warnings: [{ id, status }]`, the direct predecessors that are neither closed nor labeled `main-wait`, read after the handoff commits; released clients ignore it. The change feed emits `dependency_added` and `dependency_removed` on `later_id` with the new optional field `relation: "lands_after"`, and never `became_ready` for land order. `/ui/i/<id>` shows a `Lands after` section and the activity page names land-order events. schema: 9 (new tables `land_order`, `land_order_revisions`, `land_order_requests`, the nullable column `change_events.relation`, and a `dependencies_acyclic` trigger that walks both edge kinds); `node scripts/schema.ts --upgrade-from 8` emits the D1 migration, and `pd upgrade` upgrades a local store. Snapshot 7 adds the three collections; `pd snapshot convert --from 6` converts snapshot 6. deploy: apply the D1 migration before the Worker deploy; see `docs/d1-migration.md`. No new secrets or bindings.
- Add a read flag for started work without a claim. `list` (local, HTTP, MCP) accepts optional `claimed: true|false`, and `pd list --claimed true|false` sends it; any other CLI value is a usage error (exit 2). `claimed: true` keeps issues whose claim state is `active`; `claimed: false` keeps `never_claimed`, `released`, `expired`, and `invalidated` (a lease from another store incarnation), judged by the database clock at the read. It combines with the other filters and with pagination. `search` and the worklists do not accept it. A Worker released before the field rejects it with `invalid_input`; the cloud client does not retry without it and reports `invalid_input` with a message that asks for a newer Worker. `pd show --human` prints `Status in_progress (no active claim)` for a non-epic `in_progress` issue whose claim is not active. `/ui/working` adds the section `Started without an active claim`: non-epic `in_progress` issues without an active claim, in issue order, at most 50, through the new read-only query `startedWithoutClaim`. Nothing resets a status at release or expiry. No schema change.
- Tie `in_progress` to a held claim (local, HTTP, MCP, and every CLI). An `update` whose `status` or `type` change leaves an issue other than an epic at `in_progress` now needs a current `claim_proof` for every actor, the owner and humans included, on a never-claimed issue too. This covers an unchanged `in_progress` value, `deferred -> in_progress`, and a type change that turns an `in_progress` epic into another type; the type after the update decides. Without the proof the write fails with the existing `claim_required` (409) and its existing details: `{ issue }`, plus `claim` when a proof was supplied. `force` still bypasses prerequisites only. Epics stay exempt. `create` with `status: in_progress` and a type other than `epic` now fails with `invalid_input` before any write; create `open`, acquire, then update with the proof. Body, priority, and label edits of an `in_progress` issue need no proof. Release and expiry leave the status unchanged, stored `in_progress` rows are untouched, and snapshot import is unchanged. The SQL guard and the transition decide the same rule, so SQLite and D1 agree. The polylinedb skill, `docs/claims.md`, `docs/operations.md`, and `pd --help` say that a handoff without `claim_handoff` sets status `open` with the proof before release. Released cloud clients decode the error unchanged. No schema change.
- Add `Server-Timing: worker;dur=<ms>` to every `/mcp` response, as on `/ui`, so a slow first MCP response can be split between the Worker and the host. `initialize` and `tools/list` read no D1; their only cold cost is the Access key fetch. docs/cloud.md gains "Tools missing on the first response" (retry a cheap `actor` read; `MCP_TIMEOUT` for a local Claude Code), and the polylinedb skill tells an agent to call `actor` once more before concluding a pd tool is absent. No schema change.
- Add `claim_handoff` (MCP, HTTP, local, and `pd claim handoff`). Under `claim_proof` and `expected_revision`, one atomic write adds a `tip: <sha>` comment (`tip`: 7 to 40 lowercase hex digits) and an optional `summary` comment, sets status `open`, removes `ready`, adds `main-wait`, keeps the other labels, and releases the claim. It returns `{ claim_receipt, handoff: { issue, comments } }`. The release receipt stores the handoff request, and comment IDs derive from `request_id`, so a retry returns the first result; different arguments or a plain release with that UUID return `claim_request_conflict`. A closed issue returns `conflict`, a stale proof `claim_conflict`, and neither writes anything. The change feed records `claim_released`, `commented`, and `status_changed` or `updated`. The polylinedb-queue skill uses it, with the four separate writes as the fallback. The cloud client decodes the new result. No schema change.
- Test only: the packaged Worker check (`test/worker.integration.ts`) expects the `/ui` policy with the Dispatch script hash and `connect-src 'self'`, computed from the served script source. No runtime change.
- Send `/ui` Dispatch in place. When Dispatch is ready, the issue page adds `<output class="dispatch-result" role="status" aria-live="polite">` to the form and one fixed inline script that posts the same form with `fetch` (same origin, `credentials: 'same-origin'`, `redirect: 'manual'`). The button is disabled and reads `Sending…` until the answer; a 2xx shows the result page's sentence with the local time and clears the notes, any other answer shows that sentence (or a network or sign-in message) and keeps the notes. The press endpoint and its `Origin` rules are unchanged, and without JavaScript the form posts as before. Every `/ui` response's `Content-Security-Policy` adds the script's SHA-256 to `script-src` and adds `connect-src 'self'`. No schema or operation change.
- Test only: the forced-update rollback test compares the issue, comments, and claim before and after the failed write without `claim.observed_at`, which is the database clock at read time and could tick between the two reads. No runtime change.
- Restyle the `/ui` Dispatch form. It is a `class="dispatch"` block with the label, a full-width `notes` textarea (`rows="4"`, a placeholder, 16px text so iOS does not zoom), and a `dispatch-action` row holding the button and the start summary. The button is a 48px-tall filled primary button with hover, focus, and disabled styles, full width at 420px and narrower, and follows the dark theme. Field names, the POST target, the summary text, and Dispatch behavior are unchanged; the button stays enabled when the summary says the issue will not start, because the dispatcher decides.
- Let a cloud client ask for the issue closure on `/v1/operations` with the request header `polylinedb-issue-fields: closure` (a comma-separated token list; other tokens are ignored). With it, success and error bodies keep `closed_at` and `closed_by` on every issue; without it, both stay removed, so released CLIs see the same shape. The cloud CLI now sends the header, so `pd show`, `pd list`, and `pd close` over a cloud connection report the closure, and `pd show --human` prints the `Closed` line. The decoder accepts an issue with both keys or neither (an older Worker ignores the header) and returns `cloud_invalid_response` for only one key, a non-text value, or a closure on an issue that is not closed. Deploy the Worker for cloud clients to receive the fields. No schema change and no operation schema change.
- Add the `/ui/activity` page. It reads the change feed newest first (at most 50 events, with each issue's title and project in one query) and links to `/ui/activity?after=<seq>&incarnation=<incarnation>`, which lists later events oldest first and pages on. `cursor_expired`, `incarnation_mismatch`, a cursor ahead of the feed, and a malformed link render a plain message with a link back instead of an error. Comment rows show the kind only, because a feed event does not name its comment. Adds the read-only queries `activityNewest` and `activityAfter`; the `changes` operation is unchanged. No schema change.
- Use the next line as the `/ui` title when an issue body opens with only an owner marker. A first line such as `要対応（owner-action）`, `# 判断待ち(owner-decision)`, or `要対応（owner-action）。` (the words `要対応` or `判断待ち`, optional `#` markers, a full-width or ASCII parenthesised note, an optional `。`) gives way to the next non-empty line, at most once. A marker-only body keeps the marker as its title. Every row, the issue page `<h1>`, and the browser title use it, and the issue page shows the marker as the first line of the body text. Other first lines are unchanged. No query, schema, or API change.
- `/ui` small fixes. **Waiting for main** and project **Recently closed** rows now link to `/ui/i/<id>`. `/ui/working` rows show the issue ID before the project. The issue page Dispatch form, shown only to an Access human with write access, adds an optional `notes` textarea (`maxlength="4096"` as a hint; the server still refuses notes above 4096 UTF-8 bytes) and a one-line summary built from the issue's labels, active blockers, and claim: owner wait, status when not `open`, `ready` or `not ready`, `main-lock`, `blocked N` or `no blockers`, the active claim holder and expiry or `not claimed`, then `can start now` or `will not start now` with the ready worklist's meaning. The summary does not disable the button. No new query, form field name, schema, or API change.
- Return `previous_lease` from `claim_acquire` (local, HTTP, MCP, and `pd claim acquire`). It is the lease that expired without a release just before this acquisition, with `issue_id`, `incarnation`, `session_id`, `generation`, `actor`, `agent_label`, `revision`, `acquired_at`, `changed_at`, `expires_at`, and `released_at: null`, or `null` after a release, on a first acquisition, or when the earlier lease belongs to another store incarnation. It is read from the immutable `claim_requests` history, so a replay returns the same value. A non-null value means the earlier holder may still be running; the polylinedb skill tells the new holder to read the issue comments and the `work/<issue id>` branch first, and tells a holder that cannot renew in time to push its branch, comment, and release instead of letting the lease lapse. Released CLIs ignore the new field. The cloud client rejects a `previous_lease` for another issue or incarnation, a released one, or one whose generation is not lower than the receipt's. No schema change.
### Worker version information

Authenticated `GET /v1/version` and the read-only MCP tool `server_info` return `package_version`, `git_commit`, and `schema_version`.
The package manifest supplies both this version and MCP initialization's version. Builds from clean checkouts embed the full commit SHA. Dirty or unavailable provenance returns `null`.
The schema version comes from the connected database. Readers and agents need no claim, and the read writes nothing.
`server_info` rejects extra arguments with `invalid_input`. The local CLI operation set does not change.
No new secrets, bindings, or migrations are required. Deploy a Worker built from a clean committed checkout to identify the running artifact.

### Isolate the CLI module-loading test from host credentials

- surface: CLI test fixture
- change: the module-loading test uses an unsupported synthetic platform, so its authentication check never opens the host credential store.
- compatibility: CLI behavior does not change.

### Reject unsupported Node before tests start

- surface: `npm test`, `npm run test:d1`, `npm run test:properties`, `npm run test:package`, and the shared CLI child helper.
- change: check `package.json` `engines.node` before loading tests or starting test children.
- errors: exit 1 with the actual Node version and required range on an unsupported runtime.
- compatibility: the required Node range remains `^24.20.0 || >=26.7.0`. CLI help and version behavior remain the same.

### Queue checks and landing workflow

- Run the `Check` workflow faster. Each OS and Node pair now runs four parallel jobs named `<suite> (<os>, <node>)`: `static` runs the typecheck, `npm run check:architecture`, and `npm run check:ui-latency`; `unit` runs `npm test`; `d1` runs `npm run test:d1`; and `package` runs the Worker build, `node test/worker.integration.ts`, and `npm run test:package`. Every check that ran before still runs on every pair. `npm run check:architecture` runs its archstrict items in a pool sized to the CPUs, and `npm run test:d1` now runs `scripts/test-d1.ts`, which runs the ten local workerd D1 files in such a pool, slowest first, and prints each file's output in list order. The `Publish` workflow runs the same scripts. No CLI, Worker, or schema change.
- Stop adding a landing-record commit. Each work commit now adds its own entry under `## Unreleased` in `CHANGELOG.md` and `CHANGELOG.human.md`, and a release commit turns that section into a version section. A landing of `queue` onto main adds no commit. `## Main landings` and the dated landing entries in `CHANGELOG.human.md` stay as history.
- Run the `Check` workflow on every push except to `main` (`push: branches-ignore: [main]`), and on pull requests as before. `main` only receives fast-forwards of a queue tip whose Check already passed, so a landing adds no Check run beyond the work commit's own. The `Publish` workflow still runs on a push to `main` that changes `package.json`.
- The queue skill, `docs/agent-workflow.md`, `docs/claims.md`, and `docs/releasing.md` describe the landing: the owner, or rocky with the owner's standing permission, fast-forwards `main` to the queue tip under the main-lock once Check succeeded on that commit, then closes the landed `main-wait` issues. Other agents still do not push main, and only the owner approves the `publish` environment. No CLI, Worker, or schema change.

### Upgrade from 0.5.2

Version 0.6.0 uses schema 10 and snapshot 8. Version 0.5.2 used schema 8 and snapshot 6.
Schema 9 adds the land-order and external resource tables and the nullable `change_events.relation` column. Schema 10 adds the comment `version`, `updated_at`, and `updated_by` columns and accepts the `comment_edited` change kind. Snapshot 7 adds land order and resources, and snapshot 8 adds the comment edit fields.
Back up a local store with `pd export`, then run `pd upgrade`; it accepts canonical schemas 2 through 9. The 0.6.0 CLI refuses a store that has not been upgraded.
A snapshot written by 0.5.2 is snapshot 6. Convert it with `pd snapshot convert --from 6` before you import or restore it with 0.6.0.
Upgrade D1 first with the [database upgrade procedure](docs/d1-migration.md#upgrade-an-existing-schema-2-3-4-5-6-7-8-or-9-deployment): `node scripts/schema.ts --upgrade-from 8` for a 0.5.2 database, or `--upgrade-from 9` for a database that already has land order and resources. Then deploy the Worker. A schema 10 Worker on a schema 8 or 9 database fails every `show`.
The new Worker refuses an `update` that leaves a non-epic issue at `in_progress` without a current `claim_proof`, from every CLI version, with `claim_required`. Create the issue `open`, acquire it, then update with the proof.
The 0.5.2 CLI keeps working against the new Worker; it ignores the new comment fields, `previous_lease`, and `land_order_warnings`.
The 0.6.0 CLI works against a 0.5.2 Worker for the operations that Worker has. It retries a land-order read without the flag, and it answers `comment_edit`, `resources_reason`, and the resource operations with `invalid_input` that asks for a newer Worker.
pd now refuses to run under Bun or Deno, or on a Node build whose SQLite is older than 3.53.4, with `unsupported_runtime`. `pd --help` and `pd --version` still answer.
Worker deployment remains a separate step.

## 0.5.2 (2026-10-12)

Version 0.5.1 was published to npm, but the `release` job of its Publish run failed, so it has no `v0.5.1` tag and no GitHub Release.
Version 0.5.2 contains the fix for that job. The `pd` CLI and the Worker are the same as in 0.5.1.

- Send the request body in the `release` job of the Publish workflow. `scripts/github-release.ts` passed JSON to `gh api` on standard input without `--input -`, so the POSTs that create the annotated tag, its ref, and the GitHub Release sent no body, and GitHub answered the tag request with HTTP 422. The 0.5.1 run published to npm but created no tag or release. A re-run of that failed job runs the code of the 0.5.1 commit, so it cannot pick up this fix. Version 0.5.1 therefore keeps no tag and no GitHub Release, and 0.5.2 carries the fix. No CLI, schema, or Worker change.

### Upgrade from 0.5.1

No action is needed. Version 0.5.2 uses schema 8 and snapshot 6, as 0.5.1 does.
From 0.4.0, follow [the upgrade from 0.4.0](CHANGELOG.md#upgrade-from-040) in the 0.5.1 section.

## 0.5.1 (2026-10-12)

Version 0.5.0 was prepared on main but never published to npm. Version 0.5.1 is the first npm release since 0.4.0, and the first from the automatic Publish workflow.
It carries every change in [the 0.5.0 section](CHANGELOG.md#050-2026-10-12), plus the change in this section.

- Release automatically when a push to main changes the version. The `Publish` workflow in `.github/workflows/publish.yml` now runs on a push to `main` that changes `package.json`, and has no manual `workflow_dispatch` path. Job `check` reads the `package.json` version, requires both `package-lock.json` versions to match it, and releases nothing when the tag `v<version>` already exists, for example after a revert. Job `publish` runs under the `publish` environment, so the owner's approval is still the last gate, and keeps every earlier verification step on the pushed commit. On a re-run it skips `npm publish` only when npm already has that version with the same tarball integrity, and it always checks the registry integrity. Job `release` writes the notes and creates the annotated tag and the GitHub Release on the pushed commit; it verifies an existing annotated tag and matching release instead of recreating them. Only `publish` has `id-token: write`, only `release` has `contents: write`, and the workflow default is no permissions. The trusted publisher on npm stays bound to the `publish.yml` filename.

### Upgrade from 0.4.0

Version 0.5.1 uses schema 8 and snapshot 6, as 0.5.0 does. Version 0.4.0 used schema 6 and snapshot 5.
Schema 7 adds the `change_events` and `change_writer` tables and their triggers. Schema 8 adds the nullable `closed_at` and `closed_by` issue columns. Snapshot 6 adds the closure fields to issues and carries no events.
Back up a local store with `pd export`, then run `pd upgrade`; it accepts canonical schemas 2 through 7. The 0.5.1 CLI refuses a store that has not been upgraded. `pd export --historical` now also reads schemas 6 and 7.
A snapshot written by 0.4.0 is snapshot 5. Convert it with `pd snapshot convert --from 5` before you import or restore it with 0.5.1. The conversion leaves `closed_at` and `closed_by` null.
The new Worker fails issue, comment, claim, and prerequisite writes against a schema 6 database, and fails every status change and every closed creation against a schema 7 database.
Upgrade D1 first with the [database upgrade procedure](docs/d1-migration.md#upgrade-an-existing-schema-2-3-4-5-6-or-7-deployment): `node scripts/schema.ts --upgrade-from 6` for a 0.4.0 database, or `--upgrade-from 7` for a database that already has the change feed. Then deploy the Worker.
A 0.4.0 Worker keeps working against an upgraded database; its writes record no events and no closures.
After the new Worker closes issues, rolling the Worker back makes reopen fail on those issues. See [the rollback cost](docs/d1-migration.md#rollback-cost-of-the-schema-8-upgrade).
The 0.4.0 CLI keeps working against the new Worker; it has no `changes` command.
The 0.5.1 CLI works against a 0.4.0 Worker. `pd search` and the expired-lease `pd claim release` retry once without their new fields. A Worker without the `changes`, `wait`, or `dependency_owner_waits` operation answers those commands with `invalid_input`.
Worker deployment remains a separate step.

## 0.5.0 (2026-10-12)

- Send `/ui` pages, including their `304 Not Modified` answers, with `Referrer-Policy: same-origin` instead of `no-referrer`. Under `no-referrer`, browsers sent `Origin: null` on the same-origin form POST to `/ui/i/<id>/dispatch`, so the Dispatch button always failed with 403 `forbidden_origin`. Now that POST carries the page's real origin, and cross-origin requests still get no referrer. Dispatch origin checks are unchanged: only a missing `Origin` or the request's own origin is accepted, and `Origin: null` stays `forbidden_origin` even when `ALLOWED_ORIGINS` lists `"null"`. The speculation-rules prefetch keeps `referrer_policy: "no-referrer"`, because prefetches are GET navigations that dispatch does not see. No schema, secret, or binding change; it takes effect on the next Worker deploy.
- Ship `dist/records/attention.js` in the npm package. `src/records/index.ts` loads it, so an install that omits the file makes `pd create` exit 1 with `internal_error` and `ERR_MODULE_NOT_FOUND` instead of exit 2 `invalid_input`.
- The polylinedb-queue skill now requires the full test suite on the rebased commits after the final rebase and before the `queue` push, also after a rejected push, and reports test counts only from that run. A failure on the queue tip blocks the push. It forbids killing processes by pattern (`pkill -f`, `killall`) and allows killing only PIDs the agent started. Skill text only; no code, schema, or Worker change. `.github/workflows/check.yml` already runs on every push, including `queue`.
- Show a favicon on every `/ui` page: a polyline on the page paper, drawn in the page colors with a night variant for a dark color scheme. It is an inline SVG `data:` URI in the page head, so it adds no request, and the existing `img-src data:` policy allows it. The Content-Security-Policy, caching, and prefetch rules are unchanged.

- Branch a claim worktree from the `queue` tip. The main-lock steps belong to the owner who lands `queue` onto main. If the claim expires after the queue push, acquire the issue again to write the tip. See `docs/agent-actors.md` and `docs/claims.md`.
- Add `pd claim keepalive --claim-proof JSON [--ttl 30..3600] [--max-duration 1..28800] [--kill-on-loss] (--pid PID | -- COMMAND ...)`. It renews a claim lease through the existing `claim_show` and `claim_renew` operations until the command or process exits, so a long required check no longer lets the lease lapse. It needs no Worker or schema change and keeps the 3600 second TTL maximum. It refuses an issue labeled `main-lock`. `--max-duration` defaults to 7200 seconds and is capped at 28800. The exit code is the command's code, 0 when the claim is released, 5 with `claim_lost`, or 6 with `keepalive_max_duration`. It kills the command only with `--kill-on-loss`. Cloud agents still renew through the MCP `claim_renew` tool. See `docs/claims.md`.
- Treat an issue that waits on the owner as its own state. The ready worklist (`dependency_worklist` with `state: "ready"`, `pd ready`) now leaves out every issue labeled `owner-decision` or `owner-action`, for humans and agents alike, as it already did for `main-lock`. `main-wait` is not an owner wait and stays listed. The new read operation `dependency_owner_waits` and the command `pd owner-waits` list unfinished owner waits in ID order with their direct unfinished dependents (at most 50 each, with `dependents_next` when more exist), filtered by `tool` and `project` and paged by `after` and `limit`. The change feed and the claim gate are unchanged, and there is no schema change. An older Worker answers the new operation with `invalid_input`. Issues that carry both `ready` and an owner label leave the ready worklist after deploy; audit them with `pd list --label owner-action` and `pd list --label owner-decision`. See `docs/prerequisites.md`.
- Add `pd wait --since SEQ --timeout SECONDS` and a read-only MCP `wait` tool. The Worker and the local CLI reread the change feed about once a second until a matching event exists after `since`, or until the timeout. A timeout returns no events and the current cursor. `since` and `timeout` are required, and there is no default timeout. The call does not claim or change anything. See the waiting section of `docs/operations.md`.
- Return `open_blockers` from `claim_acquire`. The list holds the ids of active blockers, in issue order, as observed at acquire time, and it is empty when there are none. Acquire still succeeds when active blockers remain. A replay reads the list again. See `docs/claims.md`.
- Release of an expired lease can succeed as a no-op. A `claim_release` request opts in with `expired_noop: true`, and `pd claim release` always sends it. When the proof names the expired lease, the result is `released: false` and the current inspection, with `state` `expired`. The revision stays the same and the store writes no receipt. A request without the field keeps the `claim_conflict` answer, so released CLIs decode every response as before. A proof for a different session or generation still returns `claim_conflict`, including when that newer lease is expired. A Worker that does not know the field rejects it. The cloud client sends the release once more without the field. An older Worker answers `claim_conflict`, and the CLI reports that code. A Worker that answers `{ released: false, current }` for the plain release is decoded as the no-op. See `docs/claims.md`.
- Ask Git once per directory for the rest of the process. A local command reuses that answer for repository defaults, the configuration path, and external-directory checks. A directory that is not a repository is remembered the same way. A failed Git start is not remembered, so a later call asks again. See `docs/performance.md`.
- Split the `/ui` project filters into two kinds. **State** is one joined bar (one status at a time, and Unfinished means every status except closed). **Mark** is a separate row of tickets, because a label does not change the status. The selected state and the selected mark use different colors.
- Cross-fade a same-origin `/ui` navigation for 80 ms, including the transition group, and only when the browser is not asking for reduced motion. A tap during that crossfade may not reach the new page.
- Prefetch a `/ui` link the pointer rests on. Each page includes a fixed speculation-rules script, allowed by its SHA-256 hash in `script-src`. The rules use eagerness `moderate`, match only `/ui` and `/ui/…`, send no referrer, and do not prerender. Access still runs on the prefetch. The cache stays `private, no-cache`.
- Send `/ui` pages with `Cache-Control: private, no-cache` and an `ETag` instead of `no-store`. A request whose `If-None-Match` matches gets `304 Not Modified` with no body, after the same Access check. A browser that kept no-store pages out of its back-forward cache can now restore a page on Back without a request.
- Report how long the Worker waited on Access keys and D1 for each `/ui` page in a `Server-Timing` header, such as `worker;dur=12.0`. The browser developer tools show it with the request timing. A rejected caller gets no such header.
- Order the `/ui` project list by the newest issue update in each project, newest first, instead of by tool and project. Each row shows that time, such as `Updated 2026-10-10 15:40 JST`. Projects with the same update time are ordered by project name, then by tool. When more than 200 projects exist, the ones updated longest ago are left out.
- Name the file system error when the authentication lock cannot be created. `EACCES`, `EPERM`, and now `EROFS` report `auth_state_access_denied`, which a filesystem sandbox that denies writes to the configuration directory typically produces. Other errors still report `auth_lock_failed`, whose message now names the code, such as `ENOSPC`, and says that the failure is not lock contention. Both errors carry the code in `error.details.diagnostic.code` and no path. A failure to create the authentication state directory follows the same rule instead of reporting `auth_failed`. The `auth_lock_release_failed` line names the code as well.
- Order the `/ui` **Recently closed** list by `closed_at`, newest first. A recorded close shows that time and `closed_by`. An issue with no close record sorts after the recorded closes and shows its last update, which is not the close time. An edit after the close does not move a recorded close. The list reads the schema 8 closure columns and adds no further D1 migration.
- Record who closed an issue and when in `closed_at` and `closed_by`. A status change into `closed`, forced or not, and a creation with status `closed` set them to the write time and the actor. Closing an issue that is already closed keeps the first closure. Reopen and any other status change away from `closed` clear them; other edits keep them. Issues closed before schema 8 keep null; no time is guessed from `updated_at`. Local results, MCP, and `pd show --human` report them. `/v1/operations` omits them, so released cloud CLIs keep reading the same issue shape. The change feed records a close as `status_changed` with `fields: ["status"]`, as before. Snapshot 6 carries both fields; convert snapshot 5 with `pd snapshot convert --from 5`.
- Add a store-wide change feed in schema 7. The new read operation `changes` returns issue change events after a `since` sequence number, oldest first, through `pd changes`, HTTP, and a read-only MCP tool. Each event has `seq`, `incarnation`, `issue_id`, `kind`, `fields`, `occurred_at` in database time, and `actor`. The kinds are `created`, `updated` and `status_changed` with the written field names, `commented`, `claim_acquired`, `claim_released`, `dependency_added`, `dependency_removed`, and `became_ready` for an `open` dependent whose last active blocker closed or was removed. An active blocker has any status other than `closed`. Filter by `project`, `issue_ids`, and `kinds`, and continue from `next_since` with the returned `incarnation`. The store keeps the newest 10,000 events. An older cursor gets `cursor_expired`, and a cursor from another store incarnation gets `incarnation_mismatch`. Both return status 409 with the current `incarnation` and `next_since`. See the change feed section of `docs/operations.md`.
- Record each event in the same transaction as its write, on local SQLite and on D1. A rejected write, a request replay, `claim_renew`, an unchanged prerequisite edit, memory operations, a lapsed lease, snapshot import, and the D1 restore and merge operators record no event. Every existing request and response keeps its shape.
- When an agent's own lease has expired, the agent-gate `claim_required` says `The agent's own claim expired`. `details.claim` reports `state`, `generation`, and `expires_at` next to `id`. A write with no lease, or another agent's lease, still returns only `id`.
- When `update`, `close`, or `reopen` includes a `claim_proof` and the store rejects it with `claim_required`, `details.claim` sits next to `details.issue`. A lease reports `state`, `generation`, and `expires_at`. An issue that was never claimed reports `state` `never_claimed`. A rejection with no proof still returns only the issue. The cloud CLI drops `claim`, so a released CLI still accepts the response. MCP and a direct HTTP client see `claim`.
- Reject a `reason` sent without `force` with `reason is accepted only with force: true`. The MCP schema for `reason` on `update` and `close` says the same thing. `force` without a nonempty `reason` still reports `force requires true and a nonempty reason`. The call stays refused, and the text is not stored.
- Keep the authorization error when a cloud `show` follows up with `claim_show` because the Worker omitted `claim`. `pd show` reports that error with its code and its login message.
- Let `pd --claim-proof` accept a `claim_receipt` from acquire or renew. The CLI reads `issue_id`, `incarnation`, `session_id`, and `generation` and sends only those fields. HTTP and MCP still reject any other field on `claim_proof`.
- Change `auth_busy` so it says another pd process may still hold the authentication lock, for example during a token refresh or `pd auth login`, which can wait up to 300 seconds for the browser callback. Wait and retry. Delete the lock directory only after no pd process is running for this configuration. The 10 second wait is unchanged. If the lock directory already contains an entry named `login`, the message says that the holder is an interactive login.
- Keep the result of a credential operation when removing the authentication lock fails. If the lock directory remains, the command reports `auth_lock_release_failed` on standard error, and a later command can return `auth_busy` until that directory is removed.
- Wait up to 5 seconds when a local command meets another command's database lock. If the lock is still held, the command reports `store_busy` instead of `internal_error`. Retry the command.
- Stop the memory context child of the host hook after 10 s instead of 15 s. The host still caps the hook at 15 s, so a slow child now ends with the `unavailable` notice instead of a hook that the host kills without output.
- Tell where each search hit matched. A `search` request with `with_matches: true` also returns `matches`: for each issue, the body and each matching comment ID, with an excerpt of at most 160 UTF-8 bytes around the first match. A request without the field keeps the 0.3.1 result, so older CLIs still decode it. `pd search` and the MCP `search` tool always request matches, and `--human` prints a `Matched in` line for each. A Worker that predates the field rejects it. The cloud client then sends the search once more without the field and returns that page without `matches`, so the CLI and the Worker can be updated in either order.

### Upgrade from 0.4.0

Version 0.5.0 uses schema 8 and snapshot 6. Version 0.4.0 used schema 6 and snapshot 5.
Schema 7 adds the `change_events` and `change_writer` tables and their triggers. Schema 8 adds the nullable `closed_at` and `closed_by` issue columns. Snapshot 6 adds the closure fields to issues and carries no events.
Back up a local store with `pd export`, then run `pd upgrade`; it accepts canonical schemas 2 through 7. The 0.5.0 CLI refuses a store that has not been upgraded. `pd export --historical` now also reads schemas 6 and 7.
A snapshot written by 0.4.0 is snapshot 5. Convert it with `pd snapshot convert --from 5` before you import or restore it with 0.5.0. The conversion leaves `closed_at` and `closed_by` null.
The new Worker fails issue, comment, claim, and prerequisite writes against a schema 6 database, and fails every status change and every closed creation against a schema 7 database.
Upgrade D1 first with the [database upgrade procedure](docs/d1-migration.md#upgrade-an-existing-schema-2-3-4-5-6-or-7-deployment): `node scripts/schema.ts --upgrade-from 6` for a 0.4.0 database, or `--upgrade-from 7` for a database that already has the change feed. Then deploy the Worker.
A 0.4.0 Worker keeps working against an upgraded database; its writes record no events and no closures.
After the new Worker closes issues, rolling the Worker back makes reopen fail on those issues. See [the rollback cost](docs/d1-migration.md#rollback-cost-of-the-schema-8-upgrade).
The 0.4.0 CLI keeps working against the new Worker; it has no `changes` command.
The 0.5.0 CLI works against a 0.4.0 Worker. `pd search` and the expired-lease `pd claim release` retry once without their new fields. A Worker without the `changes`, `wait`, or `dependency_owner_waits` operation answers those commands with `invalid_input`.
Worker deployment remains a separate step.

## 0.4.0 (2026-10-09)

- Let an object entry in the cloud `ACCESS_ACTORS` roster carry an optional `label`, such as `Claude` or `owner`. The `/ui` page shows the label in place of the actor ID of the last update and falls back to the actor ID. Operation responses, MCP results, and stored actor IDs do not change. An invalid label makes the Access configuration invalid.
- Name every unexpected and missing field in `invalid_input` errors, with a path for nested fields (`changes[0].note`) and `<path>: expected <type>` for a wrong structure. A message echoes at most 10 names, each cut to 64 bytes, and prints `<invalid name>` for a key that is not shaped like an identifier. "Unknown field" now reads "Unexpected field".
- Name the session in claim acquisition errors. Without `--session-id` or `POLYLINEDB_SESSION_ID`, `pd claim acquire` exits with a usage error, and the Worker and MCP `claim_acquire` report `session_id` instead of `request_id` for a missing or malformed session UUID. A malformed `session_id` in a claim proof is reported the same way. No session UUID is generated, because a generated UUID would leave other processes unable to renew or release the claim.
- Print help and `pd --version` on an unsupported runtime, such as Bun, without loading storage or SQL modules. Every other command still exits with `unsupported_runtime`.
- Add the actor kind `human` or `agent` to local operations through `--actor-kind` or `POLYLINEDB_ACTOR_KIND`; the kind defaults to `human`.
- Keep issues labeled `main-lock` out of the ready worklist, and document the main-lock claim and the `tip:` comment for publishing.
- Require a local agent to name its own actor through `--actor` or `POLYLINEDB_ACTOR` instead of the shared repository actor, and document one actor per agent host.
- Let an agent actor claim only an issue labeled `ready`, and read only labeled issues from the ready worklist.
- Reject agent updates, comments, close, reopen, and prerequisite edits with `claim_required` unless the agent holds an active claim on the issue; the check and the ready-label check for acquisition run in the same transaction as the write.
- Decide issue, claim, creation, and prerequisite rejections in a pure transition module that SQLite and D1 share, and prove it against the SQL writes with a differential test.
- Let each cloud `ACCESS_ACTORS` entry carry a role: `human`, `agent`, or `reader`. A bare actor ID stays a human who writes. The Worker passes the actor kind to the agent gates, so a service-token agent claims only `ready` issues and writes only under its own claim. A `reader` gets `read_only_actor` on every write, claims included. A duplicate actor ID now makes the configuration invalid.
- Report `read_only_actor`, `not_ready`, and the agent `claim_required` from the cloud through the CLI with their codes instead of `denied` or `cloud_invalid_response`.
- Advertise MCP hints from the store effect of each tool. `dependency_list` and `dependency_worklist` are read-only. Every mutation except `comment` is idempotent, because a repeat replays its request receipt or fails its version check. `dependency_remove` is destructive. The `create` description now says to retain the request UUID for retries.
- Print a fixed message for an unexpected CLI failure instead of the underlying error message, so SQLite trigger text and local paths stay out of the output. `error.details.diagnostic` gives the error `code`, SQLite `errcode`, `errno`, and `syscall` when they have a safe shape.
- Return the claim inspection as `claim` from `show` in the CLI, the Worker API, and MCP, so a caller reads the `store_incarnation` for `claim_acquire` without `claim_show`. The human output adds a `Claim` line. Against a Worker that omits `claim`, the cloud client reads it with one `claim_show` request. The CLI 0.3.1 rejects the new field, so a cloud `pd show` from that release reports `cloud_invalid_response` against an updated Worker. MCP clients are not affected.
- Accept cloud responses that carry fields the CLI does not know, at the top level and in nested objects, so a Worker can add a response field without breaking the CLI. The CLI ignores such a field and does not print it. A missing required field, a wrong type, an unknown discriminator value, or a mismatched ID still reports `cloud_invalid_response`. An `open_blockers` array in a `claim_acquire` response is checked when it is present. See the response compatibility section of `docs/operations.md`.

### Upgrade from 0.3.1

Version 0.4.0 still uses schema 6 and snapshot 5. No `pd upgrade` is required from 0.3.1.
Install the new CLI and keep the same local connection.
Worker deployment remains a separate step.
This CLI works against the current production Worker and against a Worker built from main that adds `claim` on `show`.

## 0.3.1 (2026-10-06)

- Distinguish denied authentication state access from a busy authentication lock without exposing filesystem paths.
- Report signing-key outages with safe guidance and retain request UUIDs for explicit retries.
- Preserve complete trigger definitions in cloud setup batches and compare the database version with the deployment source.
- Add session-owned issue claims with database deadlines, incarnation fencing, and immutable request receipts.
- Require a current claim proof for status writes after claim activation, including close, reopen, and forced prerequisite overrides.
- Preserve claim history through schema 6 upgrades, snapshot 5 restoration, and guarded store transfers.
- Add explicit `--human` output for issue show, list, and search, with quiet terminal headings and safe text rendering.
- Preserve memory freshness notices in human output; keep JSON as the default and disable styling for pipes and `NO_COLOR`.

<a id="upgrade-from-020"></a>

### Upgrade from supported older versions

Version 0.3.1 uses schema 6 and snapshot 5. Version 0.2.0 does not provide claim commands.
Local upgrades accept canonical schemas 2, 3, 4, and 5 directly.
Version 0.1.0 uses schema 3 and can upgrade directly to 0.3.1 without installing 0.2.0 first.
Version 0.2.0 uses schema 5 and follows the same procedure.
The CLI requires Node.js 24.20 or later in the 24.x line, or Node.js 26.7 or later.

Stop all writers, including agents, hooks, and background processes, before installation.
Install version 0.3.1, then export a private backup before the upgrade.
Use the same named local connection for every command:

```sh
npm install --global polylinedb@0.3.1
pd --connection LOCAL export --historical --file /absolute/private/path/before-upgrade.json
pd --connection LOCAL --actor local:operator upgrade
pd --connection LOCAL list --project PROJECT
pd --connection LOCAL memory context --project PROJECT
```

Replace `LOCAL` and `PROJECT` with your connection name and project.
For an unnamed local store, replace `--connection LOCAL` with the same `--data-dir /absolute/store/path` in every `pd` command.
Choose a new backup file outside Git checkouts. The export creates the file with mode `0600` and refuses an existing file.
The new CLI's `export --historical` reads schemas 2 through 5 without changing the store and writes snapshot 5.
The upgrade does not create a backup automatically.
Local mutations require an actor. You can also supply the actor through `POLYLINEDB_ACTOR` or repository defaults.
The upgrade preserves existing records, keeps existing prerequisite graphs, and leaves issues unclaimed.
Check the preserved records before restarting writers.
For schema 6, use ordinary `export` for backups. Historical export rejects schema 6, and another upgrade reports `already_current`.
Retired stores remain read-only and refuse upgrades.
Recover a retired schema 2 through 5 store through historical export and import into a separate fresh store.
For a retired schema 6 store, use ordinary export instead. Keep the original store's retirement guards in place.

For D1, stop writers and back up the database before changing its schema or Worker.
Use the [database upgrade procedure](docs/d1-migration.md#upgrade-an-existing-schema-2-3-4-or-5-deployment) before deploying the matching Worker.
The CLI does not upgrade D1.

Snapshot file conversion is separate from a local database upgrade.
Convert an existing snapshot 4 file explicitly before import:

```sh
pd snapshot convert --from 4 --file OLD --output NEW
```

Conversion writes snapshot 5 with empty claim collections. Versions 2 and 3 also require their explicit conversion option.
Restoration preserves claim history but gives the destination new authority. Old proofs cannot authorize new writes there.
Check the installed CLI help or MCP schemas before using the [claim workflow](docs/claims.md).

## 0.2.0 (2026-10-05)

- Add prerequisite graphs with aggregate CAS, immutable mutation receipts, and ready/blocked worklists.
- Guard start and close with active prerequisites; store explicit forced exceptions as atomic attributed comments.
- Upgrade canonical schemas 2, 3, and 4 to schema 5 and transfer graph state through snapshot 4.
- Recover canonical retired historical stores through read-only export.

- Explain the prefix source when a shorthand issue or memory ID is missing.
- Identify the containment rule that rejects a local data directory.
- Clarify import actors, parent conversion, external knowledge transfer, and manual blocker conventions in the migration guide.
- Define the affected tool separately from the project and audit actor.
- Reject unsupported Node runtimes before loading CLI operations and report package and Node versions with `pd --version`.
- Document fixed-Node launch wrappers for installations managed by version managers.
- Report valid Worker access configuration errors with safe CLI guidance.
- Distinguish busy OAuth callback ports from denied loopback access.
- Return `store_retired` when the CLI writes to a retired local store.
- Pin Node 24 GitHub Actions and check Ubuntu 24.04 and 26.04 with Node 24 and 26.
- Install and remove user-scope memory hooks for local Claude Code, Codex, and Cursor sessions.
- Detect project memory changes during issue operations with an optional context observation token.
- Add memory revisions and store identity through explicit local upgrades, now targeting schema 5.
- Document D1 upgrades and identity rotation after a raw database restore.
- Preserve an existing SQLite journal mode when opening a local store.
- Check architecture layers in CI and add seeded behavior properties and bounded mutation tests.

### Upgrade from 0.1.0

The CLI requires Node.js 24.20 or later in the 24.x line, or Node.js 26.7 or later.
This release uses database schema 5 and snapshot format 4. Stop writers and preserve a private backup before an upgrade.

For a local connection, install the new CLI and use the same named connection for each command:

```sh
npm install --global polylinedb@0.2.0
pd --connection LOCAL export --historical --file /absolute/private/path/before-upgrade.json
pd --connection LOCAL upgrade
pd --connection LOCAL list --project PROJECT
pd --connection LOCAL memory context --project PROJECT
```

Replace `LOCAL` with your local connection name. Choose a new backup path outside Git.
The upgrade preserves existing records and creates empty prerequisite graphs.
Retired stores remain read-only. Recover them with historical export into a separate destination.

For Cloudflare, stop writers and back up D1 before changing its schema or Worker.
Use the [D1 upgrade procedure](docs/d1-migration.md#upgrade-an-existing-schema-2-3-or-4-deployment).
Apply the migration for the current schema, verify the preserved records, then deploy the new Worker.
The CLI's `upgrade` command does not upgrade D1.

Convert an older snapshot before import:

```sh
pd snapshot convert --from 2 --file OLD --output NEW
```

For snapshot 3, use `--from 3` instead. Conversion writes snapshot 4 and preserves original creation receipts.
Review source IDs before adding structured prerequisites. Existing blocker text does not create graph edges automatically.

## 0.1.0 (2026-10-04)

### Task and memory operations

- Store project knowledge with `pd memory` and the corresponding HTTP and MCP operations.
- Retrieve bounded project context through the bundled agent skill.
- Detect stale memory updates and deletions with record versions.
- Retain creation receipts after memory deletion so retries cannot recreate deleted entries.
- Transfer issues and memories with snapshot v3, including counters and audit records.
- Upgrade local schema 2 stores explicitly and convert existing v2 snapshots.

### Connections and authentication

- Select named local SQLite or Cloudflare connections from the CLI.
- Keep repository defaults in Git metadata and local databases outside the checkout.
- Authenticate the CLI with OAuth PKCE and a temporary loopback callback.
- Store credentials in macOS Keychain or Linux Secret Service.
- Refresh credentials across local processes and revoke grants on logout.
- Display centered authorization callback pages with light and dark themes.

### Cloud deployment

- Document Worker, D1, and Access Managed OAuth setup with the Cloudflare CLI.
- Document connector setup and observed results for cloud agent hosts.
- Restore snapshots into an isolated D1 destination with resumable writes and complete readback verification.
- Add disjoint local records to an existing D1 store through a guarded operator batch, then change shared repository defaults.
- Retire the previous local store for writes while retaining read access and recovery snapshots.

Automatic host hooks for memory retrieval remain separate work. The bundled skill supplies the retrieval instructions.

## 0.0.1

The initial version provides a local SQLite issue store and shared operations for a Cloudflare Worker backed by D1.
Issue updates use field versions. Creation requests use UUIDs for retry detection.
