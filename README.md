# polylinedb

polylinedb (polyline database) is a personal issue store for local tools and cloud agents.
Its command is `pd`, and its unscoped npm package name is `polylinedb`.
The CLI uses one SQLite file outside your working repository.
The Cloudflare Worker provides the same operations through HTTP and remote MCP, with D1 as its database.
These are independent stores; polylinedb does not synchronize them.

## Start locally

Use Node.js 24 or later.
The CLI needs no package installation or running server.
Run these commands from this project directory:

```sh
node src/cli.ts init
node src/cli.ts --actor local:owner create --tool compiler --project parser --body 'Handle empty input'
node src/cli.ts list
node src/cli.ts --help
```

The default directory is `$XDG_DATA_HOME/polylinedb` when `XDG_DATA_HOME` is absolute, or `~/.local/share/polylinedb` otherwise.
Use `--data-dir /absolute/external/directory` or `POLYLINEDB_DATA_DIR` to select another directory.
The directory must be outside your current working directory and any enclosing Git repository.
An existing data directory must have mode `0700`; its database must have mode `0600`.
SQLite can create a temporary journal during writes, but the persistent store is `polylinedb.sqlite`.

All commands except help return JSON.
Set `POLYLINEDB_ACTOR` or pass `--actor` for each mutation.
The actor identifies the caller for local attribution; filesystem permissions control local access.

## Edit an issue

Read the issue before writing, then use the returned field versions:

```sh
node src/cli.ts show ISSUE_ID
node src/cli.ts --actor local:owner update ISSUE_ID --status in_progress --expect status=1
node src/cli.ts --actor local:owner comment ISSUE_ID --body 'Reproduced with empty input'
node src/cli.ts --actor local:owner close ISSUE_ID --expected 2
node src/cli.ts --actor local:owner reopen ISSUE_ID --expected 3
```

The example versions assume the issue started at version 1 and each previous command succeeded.
A conflicting update fails as a whole.
Read again and decide whether the proposed edit still applies.
polylinedb does not retry with newer versions automatically.

Create an epic with `--type epic`, then create children with `--parent EPIC_ID`.
A child ID appends a UUID suffix to the parent ID.
Closing an epic does not close its children.

```sh
node src/cli.ts list --status deferred --label maintenance
node src/cli.ts search 'empty input' --project parser
node src/cli.ts search -- -Werror
node src/cli.ts --actor local:owner update ISSUE_ID --body-file ./description.md --expect body=1
```

Search matches literal, case-sensitive text in bodies and comments.
`--body-file -` reads standard input.
See the [operation contract](docs/operations.md) for fields, defaults, pagination, and errors.

## Use cloud agents

Deploy the Worker behind Cloudflare Access with Managed OAuth.
Connect an agent host to its `/mcp` endpoint through the host's protected connector storage.
Credentials must stay outside prompts, tool arguments, and the agent's readable sandbox.
The Worker accepts a verified Access assertion and uses an explicit actor allowlist.

See [cloud setup and acceptance checks](docs/cloud.md).
Local tests do not establish that a particular cloud host preserves and refreshes OAuth grants across tasks.

## Develop

The development dependencies are pinned in the package manifest and lockfile.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:d1
npm run test:worker
```

The D1 tests and Worker build need permission to listen on loopback interfaces.
`test:worker` builds and tests the actual bundle in workerd, with D1 and signed test assertions.
The build uses the installed `cf` CLI and produces `.cloudflare/output/v0/`.
It does not deploy the Worker.
The Vite plugin supports `cloudflare.config.ts` through its experimental configuration interface.
The `undici` override selects a security-fixed version for Cloudflare's development tools.
See [development dependencies](docs/dependencies.md) for the selection record.

Read the [architecture](docs/architecture.md) and [field version decision](docs/adr/0001-field-versions.md).
