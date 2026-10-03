# Prepare and publish a release

The npm package contains the compiled CLI, its local store modules, the license, documentation, and the polylinedb agent skill.
The Worker requires a source checkout and separate deployment.
The GitHub repository can remain private while the npm package is public.

## Release stages

Version `0.0.1` is the initial version. Version `0.1.0` adds the verified local and cloud workflows.
Keep the repository private until the owner approves publication.
Release `0.1.0` after actual local use and deployed Cloudflare use pass acceptance checks.
Verify local installation, persistence, and field conflicts with the installed package.
Verify the deployed Worker, D1 persistence, Access policy, and cloud-agent OAuth reuse with the [cloud acceptance checks](cloud.md#verify-each-host-and-d1).
Local workerd tests support development but do not satisfy deployed Cloudflare acceptance.
Make the GitHub repository public as part of the `0.1.0` release, after owner confirmation of those results.

## Prepare an artifact

Use a source checkout with the exact development dependencies from the lockfile.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:d1
npm run test:worker
npm audit
npm run test:package -- /absolute/path/polylinedb-0.1.0.tgz
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
Confirm the package name, version, MIT license, file list, and tarball integrity with the owner.
Keep credentials outside the repository and chat.
Use an authenticated npm session with publish permission for the unscoped name.

```sh
npm whoami --registry=https://registry.npmjs.org/
npm publish /absolute/path/polylinedb-0.1.0.tgz --dry-run --access public --registry=https://registry.npmjs.org/
```

After approval, publish that same tarball:

```sh
npm publish /absolute/path/polylinedb-0.1.0.tgz --access public --registry=https://registry.npmjs.org/
npm view polylinedb@0.1.0 version dist.integrity --registry=https://registry.npmjs.org/
```

Compare the registry integrity with the tested artifact.
Then install the published version in a clean prefix and check `pd --help`.
Do not rebuild between approval and publication.
Choose a new version for later changes, and update both the manifest and lockfile before packing.
