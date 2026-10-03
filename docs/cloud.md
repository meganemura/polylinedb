# Deploy and connect the cloud store

The cloud Worker stores issues in D1. The local CLI stores issues in its own SQLite database. The two stores do not synchronize.

To transfer an existing local store, use the [D1 snapshot migration guide](d1-migration.md). Restore into an isolated destination and verify its complete contents before changing the Worker binding.

The setup commands, Worker deployment, and unauthenticated OAuth discovery have been exercised against Cloudflare.
Cursor Cloud linking, actor identity, and issue creation with a comment were verified.
A new Cursor Cloud agent used the connection without another login.
The operator also confirmed ChatGPT custom MCP linking, `actor`, and an existing issue's contents and comments.
Token refresh after access-token expiry remains unverified.
Complete the acceptance checks in your own account before relying on the store.

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
| Cursor Cloud Agents | HTTP MCP calls use a backend proxy. Cursor documents that credentials remain outside the agent VM. | Linking, actor, create, show, and comment passed. A new agent needed no additional login. Expired-token refresh remains unverified. |
| ChatGPT custom MCP | OAuth with dynamic client registration through the public HTTPS endpoint. | The operator confirmed linking, actor, and issue/comment reads. Writes and expired-token refresh remain unverified. |
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

## Build your own cloud store

Use a source checkout, Node.js 24.20 or later in the 24.x line, or Node.js 26.7 or later, and the `cf` CLI.
The npm CLI package does not contain the Worker source.
Enable Zero Trust in your Cloudflare account and choose an Access identity provider before creating the application.
Your account needs permission to manage Workers, D1, and Access applications and policies.

Replace every uppercase placeholder below with your own value before running a command.
Keep account IDs, domains, email addresses, application JSON, build output, snapshots, and receipts outside the checkout.
Keep these values out of the checkout, including ignored files.
Run commands that change cloud resources only after you review the account and destination.
If an agent runs those commands for you, give explicit approval for resource creation, schema writes, and deployment.

The authentication, Access application creation, D1 creation, schema, and deployment commands below were exercised with `cf` version `1.0.0-beta.12`.
Check command support for your installed version with anonymous queries such as `cf cli search "create an Access application"`.
Use the matching command's `--help` for flags.
Repeat the connector acceptance checks below for your own account.

### Prepare a private deployment copy

From the source checkout, create an untracked source copy in a private directory outside Git:

```sh
umask 077
export PD_DEPLOY_DIRECTORY='/ABSOLUTE/PRIVATE_DEPLOY_DIRECTORY'
mkdir -m 700 "$PD_DEPLOY_DIRECTORY"
git archive HEAD | tar -x -C "$PD_DEPLOY_DIRECTORY"
cd "$PD_DEPLOY_DIRECTORY"
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:d1
```

Use an empty destination directory and the committed source version you intend to deploy.
Keep subsequent configuration files, command output, and `.cloudflare` build output in this private copy.

Authenticate `cf` in your own browser and inspect the selected identity:

```sh
cf auth login
cf auth whoami
export CLOUDFLARE_ACCOUNT_ID='ACCOUNT_ID'
export POLYLINEDB_WORKER_NAME='WORKER_NAME'
export POLYLINEDB_D1_NAME='DATABASE_NAME'
export POLYLINEDB_ACCESS_TEAM_DOMAIN='TEAM_LABEL.cloudflareaccess.com'
```

Copy your account ID from the authenticated account list.
Choose resource names for this deployment.
The Worker hostname is `WORKER_NAME.WORKERS_SUBDOMAIN.workers.dev`, unless you configure a custom domain.
Find your Workers subdomain in the Cloudflare dashboard before creating the Access application.
Keep `CLOUDFLARE_ACCOUNT_ID` fixed for every command in this session.

### Create the Access application and owner policy

List your configured identity providers:

```sh
cf zero-trust identity-providers list
```

Copy the ID of the provider that your owner uses.
For email one-time PIN authentication, select that provider's ID.
Store this JSON as `access-application.json` in the private deployment copy:

```json
{
	"name": "APPLICATION_NAME",
	"type": "self_hosted",
	"domain": "WORKER_HOSTNAME",
	"session_duration": "24h",
	"app_launcher_visible": false,
	"auto_redirect_to_identity": false,
	"allowed_idps": ["IDENTITY_PROVIDER_ID"],
	"oauth_configuration": {
		"enabled": true,
		"dynamic_client_registration": {
			"enabled": true,
			"allow_any_on_localhost": false,
			"allow_any_on_loopback": false,
			"allowed_uris": ["https://www.cursor.com/agents/mcp/oauth/callback"]
		},
		"grant": {
			"access_token_lifetime": "15m",
			"session_duration": "336h"
		}
	},
	"policies": [{
		"name": "OWNER_POLICY_NAME",
		"decision": "allow",
		"include": [{"email": {"email": "OWNER_EMAIL"}}],
		"exclude": [],
		"require": [],
		"precedence": 1
	}]
}
```

Use the complete hostname without a scheme or path as `domain`.
This example connects Cursor Cloud Agents.
For another host, replace `allowed_uris` with that host's documented callback.
Keep localhost and loopback registration disabled for a cloud-only connection.
The example uses a 15-minute access token and a two-week grant.
Adjust those durations to your policy using the [Managed OAuth settings](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/#managed-oauth-settings).

Create the application and policy together:

```sh
cf zero-trust access applications create --body "$(cat access-application.json)"
```

The `policies` array creates the owner policy with the application.
Record the returned application `id` and `aud` in your private configuration.
Set the Worker audience to the returned `aud`:

```sh
export PD_ACCESS_APPLICATION_ID='APPLICATION_ID'
export POLYLINEDB_ACCESS_AUD='APPLICATION_AUDIENCE'
cf zero-trust access applications get "$PD_ACCESS_APPLICATION_ID"
```

Check the returned hostname, owner policy, identity provider, and OAuth settings.
If you change the application later, preserve its complete configuration in the update body.
Cloudflare's [Managed OAuth setup](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/#enable-managed-oauth-on-a-self-hosted-application) explains that update requirement.
The protected hostname must serve Access discovery and its authentication challenge.

### Create and initialize D1

Create a separate database for this deployment:

```sh
cf d1 create --name "$POLYLINEDB_D1_NAME" --read-replication-mode disabled
export PD_D1_DATABASE_ID='DATABASE_UUID'
```

Replace `DATABASE_UUID` with the ID returned by the create command.
Apply the schema only to this new, empty database:

```sh
cf d1 query "$PD_D1_DATABASE_ID" --sql "$(node scripts/schema.ts)"
cf d1 query "$PD_D1_DATABASE_ID" --sql 'SELECT version FROM schema_version'
```

The version query must return `2`.
`scripts/schema.ts` emits the SQL owned by `src/schema.ts`.
That SQL creates tables and the schema-version record.
It is not safe to apply twice, and it does not upgrade an existing database.
Local `pd init` initializes SQLite rather than D1.

If you transfer a local snapshot, complete the [D1 migration procedure](d1-migration.md) before binding a Worker to the database.
Keep the destination free of other writers until migration verification finishes.

### Set the owner actor and deploy

The Worker allowlist uses the owner's Access subject ID, not the owner's email or the account ID.
Find the owner in your Access users:

```sh
cf zero-trust access users list --email 'OWNER_EMAIL'
```

Use the listed Access user ID for `OWNER_SUBJECT`.
Confirm that subject through the connected `actor` tool after deployment.
The connected Cursor Cloud actor matched the configured Access user ID in the acceptance run.

If the owner has not signed in to Access, use this bootstrap sequence.
This sequence is proposed and has not yet been exercised from a new account:

1. Set `POLYLINEDB_ACCESS_ACTORS='[]'` and deploy using the build and inspection steps below.
2. Open the protected Worker hostname in your own browser and sign in as the owner.
3. Run the users-list command again and record the owner's Access user ID outside Git.
4. Set the actor allowlist to that candidate and repeat the build and deployment.
5. Confirm the exact actor through the host connector before acceptance.

The empty allowlist refuses application operations even after a successful Access sign-in.
Keep the owner-only Access policy in place throughout bootstrap.
Use `access:OWNER_SUBJECT` as the actor value:

```sh
export POLYLINEDB_ACCESS_ACTORS='["access:OWNER_SUBJECT"]'
export POLYLINEDB_ALLOWED_ORIGINS='[]'
npm run build:worker
```

Keep origins empty unless your selected connector sends an Origin header.
If it does, allow that exact origin.
Do not use a wildcard.

Inspect the generated `.cloudflare/output/v0/workers/default/worker.config.json` before deployment.
Check the Worker name, `DB` database name, Access domain, audience, actors, and `previewUrls: false`.
After approving those values, deploy:

```sh
cf deploy
```

After deployment, verify that `DB` resolves to the recorded database UUID in your account.
Read the deployed version's bindings:

```sh
cf workers versions get latest --worker-id "$POLYLINEDB_WORKER_NAME"
```

Check that its version ID matches the deployment receipt.
In `bindings`, the entry named `DB` must have `type: "d1"` and `database_id` equal to your recorded database UUID.
Inspect the deployed Worker settings:

```sh
cf workers list --per-page 100
```

Find your Worker by its configured name and inspect `subdomain`.
For a `workers.dev` deployment, check `enabled: true`, `previews_enabled: false`, and the expected `url`.
Those deployed settings were confirmed in the setup run.
If your Worker is on another result page, request that page before evaluating its settings.
Check the deployed hostname and all alternate routes in the dashboard.
Disable or protect alternate hostnames and preview routes.
Neither compilation nor a deployment receipt proves the database binding or the OAuth path.

If `cf` reports a missing platform-specific workerd binary, repair the CLI installation before deployment.
Preserve optional dependencies when installing `cf`.
Do not change the application to bypass that installation failure.

### Connect the cloud host

Check discovery before linking the connector:

```sh
curl -i -X POST 'https://WORKER_HOSTNAME/mcp' \
	-H 'Accept: application/json, text/event-stream' \
	-H 'Content-Type: application/json' \
	--data '{"jsonrpc":"2.0","id":1,"method":"ping"}'
curl -sS 'https://WORKER_HOSTNAME/.well-known/oauth-protected-resource'
```

The unauthenticated POST must return `401` with a `WWW-Authenticate` Bearer challenge that names OAuth resource metadata.
The metadata must name your protected resource and its authorization server.
These discovery responses were observed on the deployed Worker.
They establish the Access challenge rather than a successful connector grant.

In the selected host's remote MCP controls, add `https://WORKER_HOSTNAME/mcp` as an HTTP server.
Complete OAuth with the owner identity that the Access policy permits.
For Cursor Cloud Agents, use the personal MCP controls at `cursor.com/agents`.
Keep OAuth credentials in the host's credential store.

Run the `actor` tool and compare the returned actor with `POLYLINEDB_ACCESS_ACTORS`.
Then run the acceptance checks below in a dedicated test project.
If the host cannot link or refresh its grant, keep that host unverified rather than copying credentials into its agent VM.

### Register a ChatGPT connection

In ChatGPT's custom MCP settings, choose OAuth with dynamic client registration for this Access configuration.
The example Access application above allows only Cursor's callback, so configure ChatGPT's callback before expecting its registration to succeed.
OpenAI specifies either `https://chatgpt.com/connector_platform_oauth_redirect` or a connection-specific URL under `https://chatgpt.com/connector/oauth/`.
Use the exact Redirect URI shown in the connection's management page.
See OpenAI's [redirect URL contract](https://developers.openai.com/plugins/build/auth#redirect-url).

Use complete redirect URIs in the DCR allowlist, without wildcard patterns.
A registration allowlist determines which callback URIs new clients may register; it is separate from matching a registered client's redirect during authorization.
Allowing an entire callback path admits other connections in that path, not only the intended connection.
An owner-only Access policy still restricts users, but does not make that broader registration scope equivalent to a fixed callback.
OAuth's [security best practice](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.1) requires exact matching against registered redirects, apart from native-app loopback port exceptions.
If the interface does not expose the required URI, resolve that registration step with the provider before expanding the allowlist.
Do not use a wildcard as the standard bootstrap procedure.
Keep the owner policy, existing callbacks, and token durations unchanged.

Read the current application before changing it:

```sh
cf zero-trust access applications get "$PD_ACCESS_APPLICATION_ID" > access-current.json
```

In the private deployment copy, prepare `access-updated.json` with the current configuration and the required additions to `oauth_configuration.dynamic_client_registration.allowed_uris`.
Review the change, then apply it:

```sh
cf zero-trust access applications update "$PD_ACCESS_APPLICATION_ID" --body "$(cat access-updated.json)"
```

Compare the returned owner policy, identity provider, audience, and grant durations with the saved configuration.
Retry registration and test `actor` and `show` through ChatGPT.
A successful ChatGPT connection does not establish availability in a Codex Cloud task; test that product separately.

## Verify each host and D1

Use a dedicated test project in the deployed store. Record the exact host product, account configuration, date, and observed result for each check. Keep credentials out of the report.

On October 3, 2026, the operator confirmed Cursor Cloud linking and a new agent's `actor`, `create`, `show`, and `comment` calls.
The agent needed no additional login.
An independent D1 query confirmed the issue, comment, and expected audit actor.
This confirms connection reuse during that test interval, but not refresh after token expiry.

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
