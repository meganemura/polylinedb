# Server build provenance

The deployed Worker needs an identity that operators can compare with a source commit.
The local CLI and its database do not have that Worker identity.

The Worker owns a read-only `server_info` MCP tool and an authenticated `GET /v1/version` endpoint.
Both call one function and return the package version, build commit, and connected database schema version.
The database supplies its version because a source constant cannot prove that migrations reached a deployed database.

Vite replaces an immutable commit literal during the build.
The package manifest supplies the version for both MCP initialization and server information.
A clean checkout supplies its full commit SHA. Dirty, untracked, or unavailable source provenance produces `null`.
Runtime bindings could be changed independently of the artifact and would require extra deployment configuration.
Build literals avoid that mismatch and require no new Worker bindings or secrets.

The tool stays outside the shared record-operation union.
Adding Worker identity to that union would give local storage an operation whose meaning depends on another runtime.
Authentication and origin checks remain the same as other Worker reads.
