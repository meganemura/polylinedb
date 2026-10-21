# Release polylinedb

This is the single release guide for polylinedb.
The npm package contains the compiled CLI, its local store modules, the license, documentation, and the polylinedb agent skill.
The Worker requires a source checkout and a separate deployment, described in [the cloud guide](cloud.md).

## Release stages

Build the Worker from the committed, clean checkout so `server_info.git_commit` identifies the artifact.
After an authorized deployment, record the build commit and the returned server information in the deployment record.
Compare the server commit with the build commit and the database version with the required migration version.
An uncommitted or unavailable checkout reports `git_commit: null` and cannot confirm deployment identity.

Version `0.0.1` is the initial version. Version `0.1.0` adds the verified local and cloud workflows.
Version `0.2.0` adds prerequisites, memory freshness, and automatic host hooks.
Version `0.3.1` adds session-owned issue claims and explicit human CLI output.
Version `0.4.0` accepts unknown cloud response fields and completes `show` without `claim` through `claim_show`.
Version `0.5.0` adds the change feed, `pd wait`, owner waits, claim keepalive, and issue closure records, with schema 8 and snapshot 6.
Version `0.5.0` was prepared on main but never published to npm.
Version `0.5.1` is the first release from the automatic workflow and carries the changes of `0.5.0`.
Version `0.5.1` reached npm, but its `release` job failed, so it has no tag and no GitHub Release. Version `0.5.2` fixes that job and has the same CLI and Worker as `0.5.1`.
Version `0.6.0` adds comment edits, external resources, land order, `claim_handoff`, and the `/ui` write forms, with schema 10 and snapshot 8.

## Cut a release

1. Choose a version that has never been tagged or published. A version that npm or a tag already holds cannot be reused.
2. In one commit, set the version in `package.json` and in both `version` and `packages[""].version` of `package-lock.json`.
   `npm version X.Y.Z --no-git-tag-version` updates the manifest and the lockfile. MCP initialization and `server_info` read the same package version.
3. In the same commit, turn `## Unreleased` in `CHANGELOG.md` into `## X.Y.Z (YYYY-MM-DD)` and add an empty `## Unreleased` above it. End the section with an `### Upgrade from` subsection when users must act. Mention the release in `CHANGELOG.human.md`.
4. Check the notes from a source checkout. The command fails when the section is missing or empty:

   ```sh
   RELEASE_VERSION=X.Y.Z node scripts/release-notes.ts
   ```

5. Enqueue the commit on `queue` with the queue skill (`skills/polylinedb-queue/SKILL.md`), including the full test suite after the final rebase.
6. Once Check is green on the queue tip, the owner or rocky fast-forwards main to it under the main-lock. A landing adds no commit of its own.
7. The push to main that changes `package.json` starts the `Publish` workflow. The owner reviews the run and approves the `publish` environment.

Nobody pushes a release tag, runs `npm publish`, or creates a GitHub Release by hand. The workflow does all three.

## The Publish workflow

`.github/workflows/publish.yml` runs on a push to `main` that changes `package.json`. It has no manual trigger.
npm trusted publishing is bound to the filename `publish.yml`, so never rename the file.
The workflow grants no permissions by default. One run at a time holds the `npm-publish` concurrency group, and a queued run waits instead of cancelling another.
Every action is pinned to a full commit SHA.

### check

`check` reads the `package.json` version and requires the `X.Y.Z` form.
Both lockfile versions must equal it, or the job fails.
It looks for the tag `vX.Y.Z` with `git ls-remote --exit-code --tags origin`.
When the tag exists, it logs that and releases nothing. This covers a push that changes `package.json` without a new version, and a revert of a version bump.
When the tag is missing, it passes the version to the next jobs.
It has `contents: read` only.

### publish

`publish` runs only when `check` found a new version.
It uses the `publish` environment, whose required reviewer is the owner. The owner's approval is the last gate before npm.
It has `contents: read` and `id-token: write`, and it is the only job with the OIDC grant.
On the pushed commit it checks the release notes, then runs `npm ci --ignore-scripts`, the typecheck, the architecture check, the unit tests, the D1 tests, the Worker build and integration test, `npm audit`, and the package check that writes the tested tarball.
It publishes that tarball with `--ignore-scripts --access public`, after a dry run, without another pack or build.
It then reads `dist.integrity` from the registry and requires it to equal the tarball's SHA-512.

Configure the `publish` environment with the owner as a required reviewer, and allow the owner to approve their own runs.
Register the trusted publisher once from an authenticated owner session:

```sh
npm trust github polylinedb --repo meganemura/polylinedb --file publish.yml --allow-publish
npm trust list polylinedb
```

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for the OIDC requirements.

### release

`release` runs after `publish` succeeds. It has `contents: write` only, and no environment, so it needs no second approval.
It writes the notes from the `CHANGELOG.md` section, then creates the annotated tag `vX.Y.Z` with the message `polylinedb X.Y.Z` on the pushed commit, and the GitHub Release `polylinedb X.Y.Z`, marked latest.
The tag's tagger is `github-actions[bot]`.

## Who does what

- Lanes prepare release commits and enqueue them on `queue`.
- The owner, or rocky with the owner's standing permission, lands `queue` onto main under the main-lock once Check is green on the queue tip. Other lanes do not push main.
- Only the owner approves the `publish` environment.
- Nobody pushes tags or runs `npm publish` by hand.
- Claude cloud sessions cannot push tags. Their git proxy answers 403 to a tag push, while branch pushes work.

## Re-runs and recovery

- **A job failed after a partial run.** Re-run the failed jobs only. A re-run keeps the outputs of `check`.
- **npm already has the version.** On a re-run, `publish` skips `npm publish` only when the registry integrity equals the new tarball's integrity, then verifies the registry as usual. Any other existing tarball fails the job, because npm never accepts a version twice. Choose a new version.
- **The tag already exists.** A new run's `check` releases nothing. A re-run of `release` reads the tag: an annotated tag on the pushed commit is kept, including one created by hand, and its message is not compared. A lightweight tag, or an annotated tag on another commit, fails the job. The workflow never deletes or moves a tag.
- **The GitHub Release already exists.** `release` keeps a published release whose title and notes match, and fails on a draft, a prerelease, or a different title or notes. It does not edit or delete a release. Correct or remove it, then re-run the failed `release` job.
- **A version bump is reverted.** Its tag either exists, so `check` releases nothing, or the version was never released. Do not reuse a version that reached npm or a tag; choose a new one.
- **A tag exists without an npm package.** `check` releases nothing for that version. Choose a new version.

Install the published version in a clean prefix and check `pd --help` before announcing the release.

## Before a release that touches the Worker or D1

A CLI release and a Worker deployment are separate steps. The workflow publishes the npm package only; it never deploys the Worker or changes D1.
Before a Worker deployment, run the D1 schema check and upgrade from [the D1 migration guide](d1-migration.md#upgrade-an-existing-schema-2-3-4-5-6-or-7-deployment), then deploy, with the owner's explicit approval.
State in the version's `### Upgrade from` subsection which CLI and Worker versions work together.
Verify the deployed Worker, D1 persistence, Access policy, and cloud-agent OAuth reuse with the [cloud acceptance checks](cloud.md#verify-each-host-and-d1).
Local workerd tests support development but do not satisfy deployed Cloudflare acceptance.
Repository visibility changes require explicit owner approval.

## Verify an artifact locally

The workflow repeats these checks, but run them before you enqueue a release commit:

```sh
npm ci --ignore-scripts
npm run typecheck
npm run check:architecture
npm test
npm run test:d1
npm run test:worker
npm audit
npm run test:package -- /absolute/path/polylinedb-X.Y.Z.tgz
```

The package check runs `npm pack`, including its `prepack` build.
It verifies the file allowlist and fetches solarsql into a temporary npm cache.
It then installs the tarball offline into a temporary prefix without development dependencies or install scripts.
It invokes the installed `pd` command for initialization, reads, mutations, comments, search, and stale-version rejection.
It also checks that the working directory remains empty.
The optional path receives the tested tarball.
Run the check on supported Node 24 and the current development runtime before release.

Inspect the tarball file list and its documentation before publication.
Check the Git history and release files for credentials, personal deployment identifiers, and machine paths.
Keep local evidence and article drafts outside the published artifact.

The build emits JavaScript because Node does not strip TypeScript inside installed packages.
See [Node TypeScript support](https://nodejs.org/api/typescript.html#type-stripping-in-dependencies).
Consumers need Node.js 24.20 or later in the 24.x line, or Node.js 26.7 or later, and its `node:sqlite` must run SQLite 3.53.4 or later.
They do not need a compiler.
Package inclusion follows npm's [files and bin settings](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/).

## Release notes

The notes are the `CHANGELOG.md` section for that version, followed by:

```sh
npm install -g polylinedb@<version>
pd --help
```

The version heading may be `## 0.4.0` or `## 0.4.0 (2026-10-09)`.
The heading line is omitted because the release title carries the version.
Every later line up to the next `## ` heading is included, so `###` subsections stay in the section.
A missing or empty section fails the publish job before `npm publish`.
The `## Main landings` section at the top of `CHANGELOG.md` and the file `CHANGELOG.human.md` are not read for release notes.
Neither changelog names pd issue ids, because readers cannot open pd. Each entry describes the change in words.

A release body has no repository base, so a relative link target in the section becomes an absolute URL at the release tag.
The repository URL comes from `repository.url` in `package.json`.
`docs/claims.md`, `./docs/claims.md`, and `/docs/claims.md` all become `https://github.com/meganemura/polylinedb/blob/v<version>/docs/claims.md`.
A `#anchor` or `?query` stays on the rewritten URL.
Reference definitions, such as `[claims]: docs/claims.md`, are rewritten the same way.
A directory target uses `tree` instead of `blob`, and an image uses `raw`.
In-page anchors such as `#upgrade-from-020`, absolute URLs, and other schemes such as `mailto:` stay unchanged.
Text in inline code spans and fenced code blocks stays unchanged.
Indented code blocks and raw HTML are not recognized, so use fenced code and Markdown links in the section.
A link that leaves the repository, such as `../other.md`, fails the publish job before `npm publish`.
`CHANGELOG.md` keeps its relative links, so it still reads correctly on GitHub and in the npm package.
