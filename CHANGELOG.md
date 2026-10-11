# Changelog for agents

This is the agent changelog. It records the behavior that an agent or an operator script depends on.
People should read [CHANGELOG.human.md](CHANGELOG.human.md), which says the same changes in plain English.

Every landing of `queue` onto main adds one entry to `## Main landings` here and one to `CHANGELOG.human.md`.
An entry covers MCP and CLI behavior, new or changed return fields, error and no-op semantics, required Worker secrets and bindings by name, D1 schema versions and migrations, and deploy prerequisites.
Entries never contain secret values, tokens, account IDs, or webhook URLs.
Entries never name pd issue ids, because readers cannot open pd. Each entry describes the change in words and ties it to its commits.

The release sections below `## Main landings`, starting with `## Unreleased`, keep their earlier form.
The publish workflow reads a version section such as `## 0.4.0 (2026-10-09)` for the GitHub Release notes, so keep those headings.

## Main landings

Newest landing first.
Each landing is a `### YYYY-MM-DD main SHORT_SHA` heading, where the SHA is the newest landed commit below the changelog commit.
Whoever lands `queue` onto main writes both entries in one commit on top of the landed commits; the 2026-10-11 entry was added afterwards.
Each change under it is a `####` heading that names the change in words, and a list of `key: value` lines, so a search such as `grep -n '^- secrets:' CHANGELOG.md` finds it.
The keys are `commits`, `surface`, `change`, `fields`, `errors`, `compatibility`, `schema`, `secrets`, `deploy`, and `status`. A key that does not apply is left out.

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
