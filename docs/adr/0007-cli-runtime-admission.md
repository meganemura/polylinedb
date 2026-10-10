# Admit supported Node runtimes before loading CLI operations

## Problem

The package manifest declares the Node versions that the CLI supports. npm can still install the package under another version. The CLI's static imports load SQLite before its command handler starts, and the SQL adapter checks Node only when a read connection opens. An unsupported runtime can therefore fail before the CLI can format an error, or initialize a store and fail on a later command.

## Decision

Keep `dist/cli.js` as the package entrypoint. It reads the adjacent package manifest, validates the declared Node range, and rejects unsupported runtimes before it imports command modules. The bootstrap accepts only positive-major caret triples and greater-than-or-equal triples, which cover the package's declared range. It reports unknown range syntax as `internal_error` rather than silently accepting it.

The bootstrap answers help and version requests before the runtime check, because these answers load no storage or SQL module. `pd --version` returns the package version and the Node version that the runtime reports, as JSON, on any runtime. Help prints for `pd` with no arguments and for a `--help` or `-h` flag that only command words precede, such as `pd search --help`. The help text lives in a module with no imports, and the command parser prints the same text.

The bootstrap returns `unsupported_runtime` for every other argument list on an unsupported Node version. The error includes the actual Node version, the required range, and the package version. The help check accepts only a subset of the forms that the parser answers with help. An option before the flag can take `--help` as its value, as in `--body --help`, so `pd --actor NAME --help` gets `unsupported_runtime` on an unsupported runtime and help on a supported one.

The command module owns option parsing, storage and authentication adapters, domain operations, and their error mapping. The bootstrap imports it dynamically only after the runtime check. This keeps the old-Node-safe startup graph small and preserves command behavior for supported runtimes.

## Consequences

The bootstrap reads one small manifest for each invocation and defers one module load for operational commands. The command module defers the cloud client in a second import. [ADR 0015](0015-deferred-cloud-client.md) records that import. A user on an unsupported runtime, such as Bun, can still read the help text and the reported Node version, and no other command runs. The manifest remains the authority for the package version and Node range. The range parser does not claim general semver support; a future engine-range syntax change must update the parser and its tests.

Version managers can select an older Node version from a repository pin. The README shows a wrapper that calls a fixed Node binary and the package entrypoint directly.
