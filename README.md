# polylinedb

polylinedb (polyline database) is a personal issue store for local tools and cloud agents.
Its command is `pd`, and its unscoped npm package name is `polylinedb`.
The CLI selects either one SQLite file outside your working repository or an authenticated cloud connection.
The Cloudflare Worker provides the same operations through HTTP and remote MCP, with D1 as its database.
These are independent stores; polylinedb does not synchronize them.

## Start locally

Use Node.js 24.20 or later in the 24.x line, or Node.js 26.7 or later.
Install Git and keep it on PATH; the CLI uses it to resolve repository defaults safely.
Install the CLI from npm:

```sh
npm install --global polylinedb
```

Run these commands from your working project:

```sh
pd init --tool compiler --project parser --actor local:owner
pd --actor local:owner create --tool compiler --project parser --body 'Handle empty input'
pd list
pd --help
```

Inside Git, initialization saves defaults in Git metadata and creates an external store under the data root's `stores` directory.
The data root is `$XDG_DATA_HOME/polylinedb` when `XDG_DATA_HOME` is absolute, or `~/.local/share/polylinedb` otherwise.
Outside Git, `pd init` initializes that data root without repository defaults.
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
pd show ISSUE_ID
pd --actor local:owner update ISSUE_ID --status in_progress --expect status=1
pd --actor local:owner comment ISSUE_ID --body 'Reproduced with empty input'
pd --actor local:owner close ISSUE_ID --expected 2
pd --actor local:owner reopen ISSUE_ID --expected 3
```

The example versions assume the issue started at version 1 and each previous command succeeded.
A conflicting update fails as a whole.
Read again and decide whether the proposed edit still applies.
polylinedb does not retry with newer versions automatically.

Create an epic with `--type epic`, then create children with `--parent EPIC_ID`.
A root ID looks like `pd-1`; its first child is `pd-1.1`.
Numbers continue from 99 to 100 without a fixed digit count.
Use `--prefix NAME` to select a numbering namespace.
The CLI accepts `pd show 1` as shorthand for `pd show pd-1` with the default prefix.
Closing an epic does not close its children.

Initialization inside Git uses stealth behavior by default; `--stealth` remains accepted.
The external store location and defaults live in Git metadata, shared by linked worktrees.
Use named connections to select a store explicitly; see [connection selection](docs/connections.md).

Create accepts `--request-id UUID` to identify a request across retries.
Reuse that UUID with the same arguments and actor after an uncertain result.
The command returns the existing issue without allocating another number.
When omitted, the CLI generates a new request UUID for that invocation.

```sh
pd list --status deferred --label maintenance
pd search 'empty input' --project parser
pd search -- -Werror
pd --actor local:owner update ISSUE_ID --body-file ./description.md --expect body=1
```

Search matches literal, case-sensitive text in bodies and comments.
`--body-file -` reads standard input.
See the [operation contract](docs/operations.md) for fields, defaults, pagination, and errors.

## Use the agent skill

The package includes [the polylinedb skill](skills/polylinedb/SKILL.md) for agents that manage local or cloud issues through the CLI.
Copy or symlink the complete `skills/polylinedb` directory into your host's skill directory.
Common user directories are `~/.codex/skills`, `~/.claude/skills`, and `~/.cursor/skills`.
Choose one installed source for each host and reload skill discovery as required by that host.
Keep `pd` available on the agent's PATH.
The skill starts with `pd context` and uses explicit project filters for shared stores.
It does not initialize a database during ordinary issue work.

## Use cloud agents

The npm package distributes the CLI, documentation, and agent skill.
Worker deployment requires access to the source repository and a separate Cloudflare setup.
Deploy the Worker behind Cloudflare Access with Managed OAuth.
Connect an agent host to its `/mcp` endpoint through the host's protected connector storage.
Credentials must stay outside prompts, tool arguments, and the agent's readable sandbox.
The Worker accepts a verified Access assertion and uses an explicit actor allowlist.

See [cloud setup and acceptance checks](docs/cloud.md).
Local tests do not establish that a particular cloud host preserves and refreshes OAuth grants across tasks.

For local CLI authentication, select a named cloud connection and run `pd --connection NAME auth login`.
Credentials use macOS Keychain or Linux Secret Service, with no plaintext fallback.
See [CLI authentication](docs/cli-authentication.md) for platform prerequisites, loopback registration, and recovery.

```sh
pd connection add cloud --url https://issues.example.com
pd --connection cloud auth login
pd --connection cloud actor
pd --connection cloud create --tool editor --project sample --body 'Check cloud operations'
pd --connection cloud list --project sample
```

Use the protected origin without `/mcp` when configuring the CLI.
Issue commands use the same fields and expected versions for either connection kind.
Cloud commands derive the actor from authentication and reject `--actor`.
They do not retry mutations after an uncertain response or fall back to local storage.
Import and export remain local commands; use the [D1 migration guide](docs/d1-migration.md) for cloud transfers.

## Develop

These commands require a source checkout, not the installed npm package.
The development dependencies are pinned in the package manifest and lockfile.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:package
npm run test:d1
npm run test:worker
```

The D1 tests and Worker build need permission to listen on loopback interfaces.
`test:worker` builds and tests the actual bundle in workerd, with D1 and signed test assertions.
The build uses the installed `cf` CLI and produces `.cloudflare/output/v0/`.
It does not deploy the Worker.
The Vite plugin supports `cloudflare.config.ts` through its experimental configuration interface.
The `undici` override selects a security-fixed version for Cloudflare's development tools.
See [dependencies](docs/dependencies.md) for the selection record.
Read queries use solarsql on SQLite and D1; see the [SQL adoption decision](docs/adr/0002-solarsql-reads.md).
After a schema or query edit, run `npm run generate:sql` and commit the generated file.

Read the [architecture](docs/architecture.md) and [field version decision](docs/adr/0001-field-versions.md).

## License

MIT. See [LICENSE](LICENSE).
