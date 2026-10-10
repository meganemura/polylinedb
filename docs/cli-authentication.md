# CLI authentication

The CLI uses a public OAuth client with PKCE to connect to a cloud store.
It registers through DCR and saves the registration for subsequent logins.
The client does not require a client secret or a Cloudflare Service Token.

## Prepare the credential store

Install Git and keep it on PATH, including on headless Linux hosts.
The CLI requires Git to inspect repository defaults before selecting a connection.
On macOS, `pd` uses `/usr/bin/security` and the user's Keychain.
Keychain may ask the user to permit access.
On Linux, install `secret-tool` and run an unlocked Secret Service on the user's D-Bus session.
For example, Debian provides `secret-tool` in `libsecret-tools`; GNOME Keyring provides a Secret Service.
A headless Linux host needs a working Secret Service session too.
The CLI reports an error if that service or the command is unavailable.
Windows credential storage is not implemented.

Tokens and OAuth registration details live together in an OS credential entry.
Connection definitions contain only the local directory or cloud origin.
Authentication locks live under the user configuration directory's `auth` subdirectory.
Lock files contain no credentials.
The CLI does not fall back to a plaintext file.

Secrets pass to the OS command through standard input.
They do not appear in command arguments, environment variables, or CLI output.
The adapter verifies writes and deletions by reading the entry again.
macOS's interactive command must be shorter than 4,096 bytes, including its arguments, encoded credential, and final newline.
Linux's encoded credential must fit within 8,191 bytes.
The CLI rejects oversized credentials before writing; it does not truncate them.

## Permit a native client

Cloudflare Access must permit the CLI's HTTP loopback callback for dynamic registration.
The listener binds only to `127.0.0.1` and uses a random callback path.
The first registration selects an available port; subsequent logins reuse that registered port.
It runs only during login.

In the Access application's Managed OAuth DCR settings, enable `allow_any_on_loopback` for native CLI clients.
Keep `allow_any_on_localhost` disabled and preserve the existing web callbacks and owner policy.
This permits loopback client registrations; it does not grant access to an unauthenticated user.
Review the complete application configuration before updating it.
See the [cloud setup guide](cloud.md) for application reads and updates.

## Log in

Add a connection using the protected origin, without `/mcp`:

```sh
pd connection add cloud --url https://issues.example.com
pd --connection cloud auth login
```

The command prints an authorization URL to standard error.
Open it in your own browser on the same machine, then complete Access authentication.
The CLI does not automate the browser.
Keep the URL out of issue reports and shared logs.
After the callback succeeds and credentials are saved, the command returns JSON status.
Authorization expires after five minutes if it does not complete.

```sh
pd --connection cloud auth status
pd --connection cloud context
```

`auth status` reports locally stored state, expiry, and refresh availability without printing tokens.
It does not contact the server, so it cannot prove that the grant remains authorized.
`context` reports the selected origin and the source of that selection without opening the credential store.
A cloud actor comes from the server's authenticated identity, not `--actor` or repository attribution.

The CLI refreshes an access token before an operation when 60 seconds or less remain.
Normal issue commands do not start an interactive login.
When authorization expires or is revoked, they ask you to run `auth login` again.
A failed repeat login preserves the previous grant until replacement succeeds.

The Worker can return `jwks_unavailable` with HTTP 503 when Cloudflare Access signing keys cannot be loaded. The CLI uses fixed guidance for this error and does not retry automatically. If the error includes `request_id`, use the same ID when you retry the operation.

## Concurrent commands and recovery

Connections with the same origin and configuration directory share credentials and an authentication lock.
Login, refresh, logout, and credential reads acquire that lock before reading the current entry.
If lock creation returns `EACCES` or `EPERM`, the CLI reports `auth_state_access_denied`.
Allow access to the authentication state directory, then retry the command.
A command that finds an existing lock waits up to ten seconds, then returns `auth_busy`.
The CLI does not steal a lock based on its age.
When lock removal fails and the directory remains, the command still returns the operation result.
It reports `auth_lock_release_failed` on standard error.
A later command can return `auth_busy` until that directory is removed.

Before spending a refresh token, the CLI saves a state that requires reauthorization.
It saves the replacement grant before using the new access token.
If the process stops after spending the old token, another process cannot unknowingly replay it.
Run `auth login` again after such an interrupted refresh.

An interrupted process can leave `oauth-HASH.lock` under `$XDG_CONFIG_HOME/polylinedb/auth`, or `~/.config/polylinedb/auth` with the default configuration.
Before removing that directory, verify that no `pd auth` or cloud operation is still running for this configuration.
Do not remove another process's active lock.
If the registered callback port is in use, the CLI reports `auth_callback_unavailable` rather than silently registering another client.
If the environment denies loopback access, the same code explains that the callback is not permitted.
Other listener failures use generic guidance without printing the operating system error.

```sh
pd --connection cloud auth logout
```

Logout attempts server revocation, then removes the local entry.
It attempts both token revocations even if one request fails.
Its JSON result distinguishes local deletion from successful, unsupported, or failed server revocation.
Local deletion alone does not prove that another copy of the token has been revoked.
Logout also removes the saved public client registration; the next login registers a new client.

Cloudflare Access can revoke the access token together with its refresh token.
The subsequent access revocation can then return HTTP 400 with `invalid_grant`.
For Cloudflare Access issuers, the CLI accepts that response after refresh revocation returns HTTP 200 in the same logout.
Other failed requests retain the `failed` result.

## Local agents and 1Password

Local Codex, Claude Code, and Cursor can invoke the same installed `pd` command.
They need the intended user configuration and access to that user's credential store.
An agent allowed to run commands as that user can act with the user's stored grant.
OS credential storage protects persistence; it does not isolate tokens from an unrestricted same-user process.

Use 1Password for long-lived credentials that you manage yourself, such as deployment credentials.
Keep the CLI's rotating OAuth session in the local OS store.
The CLI does not implement a 1Password backend or share refresh tokens between machines.
Each machine should perform its own initial authorization.

## Verification scope

Synthetic OAuth tests cover PKCE, callback checks, failed repeat login, refresh contention, interrupted refresh, failed lock release, and logout.
Credential tests cover command arguments, size limits, denied or unavailable stores, and write verification.
The macOS Keychain and a disposable Linux Secret Service both passed save, read, overwrite, delete, and missing-entry checks with synthetic credentials.
The Linux test also verified errors when the service was unavailable.
The packaged CLI passed local issue operations and unauthenticated cloud credential checks on Linux with Node.js 24.20.
Local Codex, Claude Code, and Cursor passed cloud issue operations with the installed CLI without another login.
The live check observed a later token expiry and four successful concurrent CLI processes without another login.
Synthetic tests verify that concurrent commands send one refresh request.
Server checks rejected both old tokens after logout against Cloudflare Managed OAuth.
Desktop unlock prompts and each provider's deployed OAuth policy require separate acceptance checks.
