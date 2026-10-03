# Deploy and connect the cloud store

The cloud Worker stores issues in D1. The local CLI stores issues in its own SQLite database. The two stores do not synchronize.

To transfer an existing local store, use the [D1 snapshot migration guide](d1-migration.md). Restore into an isolated destination and verify its complete contents before changing the Worker binding.

This guide describes the intended deployment and its acceptance checks. No production deployment or host connection has been verified for polylinedb.

## Establish the connection boundary

Use a host-managed remote MCP connector with OAuth. Keep its access and refresh tokens in the host's credential store. Do not place tokens in prompts, tool arguments, repository files, agent environment variables, or the agent's readable filesystem.

The request path is:

```text
Agent tool call
  -> host connector attaches OAuth token
  -> Cloudflare Access validates token and policy
  -> Worker validates Cf-Access-Jwt-Assertion and actor allowlist
  -> D1 executes the issue operation
```

Managed OAuth issues opaque tokens. Access resolves those tokens and supplies a signed assertion to the Worker. The Worker verifies that assertion; it does not decode an opaque bearer token. Access also supplies OAuth discovery and its authentication challenge. See [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

The connector can refresh an expired access token while its grant remains valid. Grant expiry requires authentication again. Revocation can require relinking. Permanent operation without authentication is not guaranteed. Choose a short access-token lifetime and a grant duration that matches your policy. Managed OAuth requires a client with RFC 8707 support. See the [Managed OAuth settings](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/#managed-oauth-settings).

## Select the actual cloud host

The following evidence was checked on October 3, 2026. Product documentation establishes available mechanisms. A successful polylinedb connection still needs a test in the selected account and cloud product.

| Host | Documented mechanism | polylinedb status |
| --- | --- | --- |
| Claude custom remote connector | Claude brokers remote MCP through Anthropic's cloud. The connector supports OAuth. | Managed OAuth linking, refresh, and tool calls are unverified. |
| Cursor Cloud Agents | HTTP MCP calls use a backend proxy. Cursor documents that credentials remain outside the agent VM. | Managed OAuth linking, refresh, and tool calls are unverified. |
| Codex Cloud | OpenAI documents OAuth for plugin MCP servers in Codex. Its MCP documentation distinguishes local host configuration from hosted plugin tools. | The exact Codex Cloud installation path, credential isolation, and Managed OAuth compatibility are unverified. |

For Claude, use the account's custom remote connector for `https://issues.example.com/mcp`. Complete OAuth in the host interface. See [Claude custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

For Cursor, add a personal HTTP MCP server through the MCP controls at `cursor.com/agents`. Complete its OAuth flow. Cursor documents that HTTP server settings, refresh tokens, and headers remain outside the agent VM. See [Cloud Agent capabilities](https://cursor.com/docs/cloud-agent/capabilities#http-vs-stdio).

Allow the exact web callback `https://www.cursor.com/agents/mcp/oauth/callback` in Access dynamic client registration. Cursor documents that callback in its [MCP guide](https://cursor.com/docs/mcp#static-redirect-url). Check the actual registration if the provider rejects it. Do not broaden the redirect allowlist to arbitrary domains.

Use the host's HTTP connector for cloud agents. `autospawn` starts and shares local stdio processes. It does not provide an HTTP OAuth connector. A local bridge through autospawn needs separate authentication and lifecycle verification. It does not establish cloud-host credential isolation.

For Codex Cloud, select a host-supported plugin or connector that brokers the remote server and owns its credentials. Verify that mechanism in the actual cloud account before relying on it. OpenAI's [plugin authentication guide](https://developers.openai.com/plugins/build/auth) describes the OAuth contract. Its [MCP guide](https://learn.chatgpt.com/docs/extend/mcp) describes the different local and hosted mechanisms.

A successful `codex mcp login` on a laptop proves that local connection. A local IDE MCP configuration likewise proves that IDE connection. Neither result establishes token storage or tool availability inside a cloud task. Do not copy a local OAuth credential file into a cloud sandbox to bridge this gap.

If the selected cloud product cannot broker the connection without exposing credentials to its agent, keep that host unavailable. A service token inside its VM does not meet this connection boundary.

## Configure the Worker

`cloudflare.config.ts` maps the following deployment environment variables to Worker bindings. Supply configuration from the operator's environment. The application identity and allowlist are configuration, not OAuth credentials.

| Operator variable | Worker binding | Required value |
| --- | --- | --- |
| `POLYLINEDB_ACCESS_TEAM_DOMAIN` | `ACCESS_TEAM_DOMAIN` | A single DNS label followed by `.cloudflareaccess.com`, without a scheme or path. |
| `POLYLINEDB_ACCESS_AUD` | `ACCESS_AUD` | The exact Access application audience. |
| `POLYLINEDB_ACCESS_ACTORS` | `ACCESS_ACTORS` | A nonempty JSON array of allowed actor IDs, such as `["access:OWNER_SUBJECT"]`. |
| `POLYLINEDB_ALLOWED_ORIGINS` | `ALLOWED_ORIGINS` | A JSON array of exact allowed Origin header values. The default is `[]`. |

The default Worker name and D1 database name are `polylinedb`. Override them with `POLYLINEDB_WORKER_NAME` and `POLYLINEDB_D1_NAME` before build or deployment. The D1 binding is `DB`. The entry point is `src/worker.ts`. Preview URLs are disabled in the project configuration.

A `workers.dev` hostname can use hostname-based Access without a custom domain. Protect the complete hostname as a self-hosted Access application. See [Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/). Check the actual deployment's routes and preview settings before acceptance.

The verifier accepts RS256 assertions from the configured issuer and application audience. It checks signature, expiry, optional `nbf`, optional `iat`, and the actor allowlist. User actors are `access:<sub>`. Service actors use `service:<common_name>` only when the assertion has no nonempty subject. A team login alone does not authorize an actor.

Missing or invalid identity returns 401. An authenticated actor outside the allowlist receives 403. Invalid authentication configuration or an unavailable signing-key endpoint returns 503. Do not log assertions, bearer tokens, or raw OAuth responses.

Both `POST /mcp` and `POST /v1/operations` require the verified actor. The MCP endpoint implements protocol `2025-11-25` with JSON responses and a 128 KiB request limit. MCP requests must accept both `application/json` and `text/event-stream`. GET streaming is not implemented. Requests with an Origin header require an exact configured match.

## Prepare the deployment

Run local checks before changing an account:

```sh
npm test
npm run build:worker
cf deploy --help
cf d1 create --help
cf d1 query --help
```

The command forms below were checked against `cf --help` and the relevant subcommand help. Confirm them again for your installed CLI. Resource creation, schema writes, and deployment require the operator's explicit approval.

1. Select the intended Cloudflare account and hostname.
2. Prepare an Access application that covers the Worker data routes.
3. Restrict its policy to the personal owner.
4. Enable Managed OAuth in the application's advanced settings.
5. Register the host's actual OAuth callback through the provider's supported registration mechanism.
6. Restrict allowed redirect URIs to the selected host.
7. Set the Worker configuration values listed above.
8. Disable or protect alternate Worker hostnames and preview routes.

Configure the Access application using the [provider's setup instructions](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/#enable-managed-oauth-on-a-self-hosted-application). The protected hostname must serve the edge's discovery and authentication challenge. polylinedb does not implement an OAuth authorization server or registration service.

After approval, an operator can create an independent D1 database:

```sh
cf d1 create --name polylinedb --read-replication-mode disabled
```

Record the returned database UUID as `D1_DATABASE_ID` in the operator's shell. Apply the shared schema only to a new, empty database:

```sh
cf d1 query "$D1_DATABASE_ID" --sql "$(node scripts/schema.ts)"
```

`scripts/schema.ts` emits the SQL owned by `src/schema.ts`. The SQL creates tables and a schema-version record. It is not a migration for an existing database and is not safe to apply twice. Keep database changes separate from local CLI initialization.

After approval, deploy the configured Worker:

```sh
cf deploy
```

Verify that `DB` resolves to the intended database and the hostname passes through the intended Access application. Neither successful compilation nor a deployment receipt proves those bindings or the OAuth path.

## Verify each host and D1

Use a dedicated test project in the deployed store. Record the exact host product, account configuration, date, and observed result for each check. Keep credentials out of the report.

- An unauthenticated request reaches the Access OAuth discovery challenge.
- Initial connector linking completes authorization and PKCE with the correct resource and callback.
- The `actor` tool returns the expected allowlisted actor.
- `create`, `show`, `list`, `search`, and `comment` work through the connector.
- A later cloud session reuses the connector grant without copying credentials into its VM.
- An expired access token refreshes through the host connector while its grant remains valid.
- Revocation denies subsequent access after the applicable token lifetime, and relinking restores access when permitted.
- Another authenticated team user cannot read or change the personal store.
- Two same-field updates from one observed version produce one success and one conflict.
- Different-field updates from an old snapshot both succeed.
- A stale field in a multi-field update prevents every requested change.
- Independent comments both remain present.
- A deliberately failing second statement in a disposable D1 batch rolls back its earlier mutation.

Do not infer credential isolation from encryption at rest alone. Confirm that the host invokes remote tools outside the agent VM and never supplies connector tokens to the model or sandbox.

Local SQLite tests and the local workerd D1 check in `test/d1.integration.ts` provide development evidence. They do not prove production D1 behavior, Access routing, host OAuth refresh, or cloud credential isolation.

## Use service tokens only from a local client

An operator-controlled local HTTP client may use an Access Service Token with a Service Auth policy. Keep that credential in the local client's protected credential source. Access must produce a verified service assertion whose actor is explicitly allowlisted.

The bundled CLI operates directly on local SQLite. It does not act as an OAuth connector or a remote service-token client. Never place a Service Token in cloud-agent setup scripts, environment variables, or tool arguments.
