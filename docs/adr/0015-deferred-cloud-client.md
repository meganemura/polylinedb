# Load the cloud client only for a cloud connection

Status: accepted.

## Problem

`src/cli-commands.ts` imported `src/cloud-client/index.ts` at module scope. Every local command therefore evaluated OAuth, the credential store, and `node:http` before it opened a local store. Help and version stay outside that graph, because the bootstrap in [ADR 0007](0007-cli-runtime-admission.md) returns before it imports the command module. A local command loads the command module.

## Decision

The command module loads the cloud client with `import()` after connection selection has chosen a cloud connection and the command needs the client. It keeps the loaded module. `runCli` maps `OAuthError` and `CredentialStoreError` only when that module is present. A local command cannot throw those errors, so an unloaded module leaves them unmapped.

`auth` and a cloud operation load the client. A local command, cloud `context`, and cloud `init` do not.

## Consequences

A local command still evaluates SQLite, workspace selection, and the domain modules. It does not evaluate OAuth, the credential store, or `node:http`. A cloud command pays for the client import on the call that uses the client. The published package still contains the cloud client files, and the Worker response shape is unchanged.
