# Connections

A connection selects a local issue directory or a cloud HTTPS origin.
Named definitions contain no credentials.
Repository defaults select a connection and retain the tool, project, prefix, and optional local actor.

## Commands

`pd connection add NAME --data-dir ABSOLUTE_PATH` adds a local connection.
`pd connection add NAME --url HTTPS_ORIGIN` adds a cloud connection.
The command requires exactly one location flag.
Names match `[a-z][a-z0-9_-]{0,63}`.
Local directories must stay outside Git repositories and metadata.
Cloud origins use HTTPS without credentials, a path, a query, or a fragment.

An identical add succeeds on each invocation.
An add with different values returns `connection_conflict`.
Definitions are immutable.

`pd connection list` returns definitions and marks the user default.
`pd connection default NAME` selects that default.
`pd connection use NAME` changes existing repository defaults and retains their tool, project, prefix, and local actor.
It requires initialized repository defaults.
These commands do not move issue data.

`pd --connection NAME COMMAND` selects a named connection for one invocation.
`POLYLINEDB_CONNECTION` selects a named connection through the environment.

For example, a repository can select either of these connections:

```sh
	pd connection add home --data-dir /srv/personal-issues
	pd connection add cloud --url https://issues.example.invalid
	pd init --connection home --tool editor --project sample --actor local:owner --prefix sm
	pd connection use cloud
	pd context
```

## Initialization

Inside a Git working tree, `pd init` saves defaults in Git common metadata.
`--stealth` remains accepted.
The first invocation requires a tool and a project.
A local connection also requires an actor from a flag, the environment, or repository defaults.
An unnamed local initialization creates an external store and writes version 2 defaults.
A named initialization writes version 3 defaults.
Cloud initialization writes repository defaults without local storage or authentication.

Identical initialization succeeds again.
Initialization with changed defaults returns `local_defaults_conflict` before creating a store.
An explicit `connection use` changes the repository selection.

Outside Git, local initialization initializes the selected store without repository defaults.
`--stealth` and cloud initialization require a Git working tree.
Linked worktrees share defaults through their Git common directory.

## Selection order

The CLI selects one complete connection in this order:

1. `--connection` or `--data-dir`.
2. `POLYLINEDB_CONNECTION` or `POLYLINEDB_DATA_DIR`.
3. Repository defaults.
4. The user default connection.
5. The existing `$XDG_DATA_HOME/polylinedb` or `~/.local/share/polylinedb` location.

Two selectors at the selected level return an error.
An explicit selector overrides environment selectors, including a conflicting pair.
The selected connection owns its location.
Lower levels do not supply location fields to that connection.
An unknown name returns `unknown_connection`.

Local actor precedence remains `--actor`, `POLYLINEDB_ACTOR`, repository actor, then `local:reader`.
Local mutations require an explicitly configured actor.
Cloud selection ignores inherited local actors and rejects `--actor`.
Cloud actors come from authentication.

## Configuration files

User configuration uses `$XDG_CONFIG_HOME/polylinedb` or `~/.config/polylinedb`.
An explicit `XDG_CONFIG_HOME` must be absolute.
The directory must stay outside Git repositories and metadata.
The CLI rejects symbolic links for configuration files, managed directories, and the configuration home.
Managed directories use mode `0700`.
Files use mode `0600` and belong to the current user.
JSON reads accept at most 16,384 bytes and validate the complete shape.

Each definition has its own `connections/NAME.json` file:

```json
{
  "version": 1,
  "definition": {
    "kind": "cloud",
    "url": "https://issues.example.invalid"
  }
}
```

Local definitions contain `kind: "local"` and `data_dir`.
Separate files let concurrent adds retain independent definitions.
Exclusive installation makes identical concurrent adds converge.

`default.json` stores `{ "version": 1, "connection": "NAME" }`.
An atomic replacement writes one complete selection.
For concurrent default changes, the last completed replacement selects the default.

Git common metadata stores `polylinedb.json`.
Version 2 retains its existing local directory and actor.
Reading that file does not convert it.
`connection use` explicitly replaces it with version 3:

```json
{
  "version": 3,
  "connection": "cloud",
  "tool": "editor",
  "project": "sample",
  "prefix": "sm",
  "actor": "local:owner"
}
```

The optional actor remains dormant during cloud selection.
Repository initialization and explicit selection share a mutation lock.
They read the current file under that lock before installation or replacement.
A writer waits for at most two seconds, then reports a locked configuration.
A process that exits during a write can leave `polylinedb.json.lock` behind.
The CLI preserves that lock until the owner resolves the interrupted write.

## Context and cloud operations

`pd context` reports `mode`, `connection`, `source`, the repository defaults, and `config_path`.
Sources are `flag`, `environment`, `repository`, `user_default`, and `legacy_default`.
Local context retains `data_dir`, `database_path`, and `actor`.
Cloud context reports `url` and `actor_source: "authenticated"` without a network request.

Cloud connections support actor, create, show, list, search, comment, update, close, and reopen.
Run `pd --connection NAME auth login` before the first operation; see [CLI authentication](cli-authentication.md).
The client sends each operation once to `/v1/operations` and preserves the supplied field versions.
Authentication or network failures do not select a local store.
After an uncertain create result, retain the reported `request_id` and reuse it with identical input if retrying.
After an uncertain comment result, inspect the issue before appending again.

Cloud import and export return `cloud_snapshot_not_supported` before file or credential access.
Cloud commands do not open or initialize SQLite.
