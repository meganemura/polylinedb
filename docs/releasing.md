# Prepare and publish a release

The npm package contains the compiled CLI, its local store modules, the license, documentation, and the polylinedb agent skill.
The Worker requires a source checkout and separate deployment.
The GitHub repository can remain private while the npm package is public.

## Release stages

Version `0.0.1` is the initial version. Version `0.1.0` adds the verified local and cloud workflows.
Version `0.2.0` adds prerequisites, memory freshness, and automatic host hooks.
Version `0.3.1` adds session-owned issue claims and explicit human CLI output.
Version `0.4.0` accepts unknown cloud response fields and completes `show` without `claim` through `claim_show`.
Database upgrades and Worker deployments require separate verification and approval.
Verify local installation, persistence, and field conflicts with the installed package.
Verify the deployed Worker, D1 persistence, Access policy, and cloud-agent OAuth reuse with the [cloud acceptance checks](cloud.md#verify-each-host-and-d1).
Local workerd tests support development but do not satisfy deployed Cloudflare acceptance.
Repository visibility changes require explicit owner approval.

## Prepare an artifact

Use a source checkout with the exact development dependencies from the lockfile.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:d1
npm run test:worker
npm audit
npm run test:package -- /absolute/path/polylinedb-0.4.0.tgz
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
Record the commit, runtime versions, test results, and tarball integrity for the owner's final review.

The build emits JavaScript because Node does not strip TypeScript inside installed packages.
See [Node TypeScript support](https://nodejs.org/api/typescript.html#type-stripping-in-dependencies).
Consumers need Node.js 24.20 or later in the 24.x line, or Node.js 26.7 or later.
They do not need a compiler.
Package inclusion follows npm's [files and bin settings](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/).

## Publish the tested artifact

Publication requires explicit owner approval immediately before execution.
Confirm the package name, version, MIT license, reviewed commit, and file list with the owner.
The approved workflow builds its tarball from that commit and verifies it before publication.
The `publish.yml` workflow uses npm trusted publishing through GitHub OIDC.
The job requests `id-token: write`. It does not use an npm token or a local npm login.
Configure the GitHub Environment `publish` with the owner as a required reviewer.
Allow the owner to approve their own workflow runs.
The publish job waits for this approval before it starts.
Register the workflow once from an authenticated owner session:

```sh
npm trust github polylinedb --repo meganemura/polylinedb --file publish.yml --allow-publish
npm trust list polylinedb
```

Push the reviewed commit to `main` and start the workflow with the exact version:

```sh
gh workflow run publish.yml --ref main -f version=0.4.0 -f commit=APPROVED_SHA
npm view polylinedb@0.4.0 version dist.integrity --registry=https://registry.npmjs.org/
```

Replace `APPROVED_SHA` with the full reviewed commit SHA.
Open the workflow run and review its commit and version before you approve the `publish` environment.
The workflow checks its source commit and the requested version before tests.
It compares the version with the manifest and lockfile.
It builds and installs the tarball, publishes that same tarball, and compares its integrity with the registry.
Keep the workflow filename consistent with the trusted publisher configuration.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) for the OIDC requirements.
Then install the published version in a clean prefix and check `pd --help`.
Publish the tested tarball without another pack or build step.
Choose a new version for later changes, and update both the manifest and lockfile before packing.
