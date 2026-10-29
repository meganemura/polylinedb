# Deploy and connect the cloud store

The cloud Worker stores issues and project memories in D1. The CLI can select that Worker or a local SQLite database. The two stores do not synchronize.
For a local CLI connected to the Worker, follow [CLI authentication](cli-authentication.md).

To transfer an existing local store, use the [D1 snapshot migration guide](d1-migration.md). Restore into an isolated destination and verify its complete contents before changing the Worker binding.

The setup commands, Worker deployment, and unauthenticated OAuth discovery have been exercised against Cloudflare.
Cursor Cloud linking, actor identity, and issue creation with a comment were verified.
A new Cursor Cloud agent used the connection without another login.
The operator also confirmed Claude and Codex Cloud issue creation, reads, and comments through their connectors.
ChatGPT custom MCP linking, `actor`, and existing issue reads were confirmed separately.
CLI checks observed token renewal and rejection of old tokens after logout.
Those CLI results do not establish each cloud host's internal refresh behavior.
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
| Claude custom remote connector | Claude brokers remote MCP through Anthropic's cloud. The connector supports OAuth. | The operator confirmed DCR linking, actor, create, show, and comment. The calls required no additional authentication. Expired-token refresh remains unverified. |
| Cursor Cloud Agents | HTTP MCP calls use a backend proxy. Cursor documents that credentials remain outside the agent VM. | Linking, actor, create, show, and comment passed. A new agent needed no additional login. Expired-token refresh remains unverified. |
| ChatGPT custom MCP | OAuth with dynamic client registration through the public HTTPS endpoint. | The operator confirmed linking, actor, and issue/comment reads. Writes and expired-token refresh remain unverified. |
| Codex Cloud | OpenAI documents OAuth for plugin MCP servers in Codex. Its MCP documentation distinguishes local host configuration from hosted plugin tools. | The operator confirmed actor, create, show, and comment through the cloud connector. Tool responses requested no additional login. Host credential isolation and expired-token refresh need separate verification. |

For Claude, use the account's custom remote connector for `https://issues.example.com/mcp`.
Choose immediate sign-in, automatic client registration (DCR), and Streamable HTTP. Leave additional request headers empty.
Allow `https://claude.ai/api/mcp/auth_callback` for that connector, then complete OAuth in the host interface.
Those settings passed the operator's connection check.
See [Claude custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

For Cursor, add a personal HTTP MCP server through the MCP controls at `cursor.com/agents`. Complete its OAuth flow. Cursor documents that HTTP server settings, refresh tokens, and headers remain outside the agent VM. See [Cloud Agent capabilities](https://cursor.com/docs/cloud-agent/capabilities#http-vs-stdio).

Allow the exact web callback `https://www.cursor.com/agents/mcp/oauth/callback` in Access dynamic client registration. Cursor documents that callback in its [MCP guide](https://cursor.com/docs/mcp#static-redirect-url). Check the actual registration if the provider rejects it. Do not broaden the redirect allowlist to arbitrary domains.

Use the host's HTTP connector for cloud agents. `autospawn` starts and shares local stdio processes. It does not provide an HTTP OAuth connector. A local bridge through autospawn needs separate authentication and lifecycle verification. It does not establish cloud-host credential isolation.

For Codex Cloud, select a host-supported plugin or connector that brokers the remote server and owns its credentials. Verify that mechanism in the actual cloud account before relying on it. OpenAI's [plugin authentication guide](https://developers.openai.com/plugins/build/auth) describes the OAuth contract. Its [MCP guide](https://learn.chatgpt.com/docs/extend/mcp) describes the different local and hosted mechanisms.

A successful `codex mcp login <name>` on a laptop proves that named server on that machine. A local IDE MCP configuration likewise proves that IDE connection. Neither result establishes token storage or tool availability inside a cloud task. Do not copy a local OAuth credential file into a cloud sandbox to bridge this gap. When Codex also shows a connector import, the two sources can list different tools and different actors. See [Refresh a connector's tool list](#refresh-a-connectors-tool-list).

If the selected cloud product cannot broker the connection without exposing credentials to its agent, keep that host unavailable. A service token inside its VM does not meet this connection boundary.

## Refresh a connector's tool list

The Worker advertises its current tools to every caller.
A host can still show an older list, because a connector import can keep the tool list from the time the connector was created.
After polylinedb adds tools, refresh that import in the host.
Calls through the saved list still reach the current Worker, so issue data can be current while the import omits tools added later.

A connector import and a configured MCP server can both be present.
Each one keeps its own tool list and its own signed-in identity.
The tool name prefix or the namespace shows which connection advertised a tool.
This host MCP connection is separate from a named [`pd` connection](connections.md).
Use the connection that advertises every tool the skill names.
An `actor` result belongs to that connection.

Codex is one example.
It can import a ChatGPT connector (a Codex App) and also read a server from its own MCP configuration.
The import can keep the creation-time tool list described above.
The configured server contributes tools after its own login: `codex mcp login <name>`, with `<name>` taken from that configuration.
A login for one of those sources leaves the other source unchanged.

Prefer the logged-in MCP server that advertises the current tools.
The `pd` CLI keeps authentication state in `$XDG_CONFIG_HOME/polylinedb/auth`, or in `~/.config/polylinedb/auth` when `XDG_CONFIG_HOME` is unset.
A sandbox can deny writes to that directory, so allow the directory before a CLI login.
[CLI authentication](cli-authentication.md) describes the resulting `auth_state_access_denied` error.

## Tools missing on the first response

Some hosts start a session before the pd MCP tools are available.
In Claude Code, the pd tools can be missing or fail on the first response of a session and work from the second.
The Worker does no D1 read for `initialize` or `tools/list`. Its only cold-start cost there is fetching the Access signing keys once per isolate.
Every `/mcp` response carries a `Server-Timing` header with one entry named `worker`, the time the Worker spent on that request, so a slow first response can be split between the Worker and the host.
In a Claude Code cloud session, the pd tools were observed to arrive as deferred tools that load after the session has started. That points at the host connecting MCP servers in the background, not at the Worker.

Until the host waits for its MCP servers, use one of these:

- Start the work with a cheap read such as `actor`. If the tool is missing or the call fails, call it once more before concluding that the connection is absent. The polylinedb skill says the same.
- For a local Claude Code, raise its MCP server startup timeout with the `MCP_TIMEOUT` environment variable, in milliseconds, for example `MCP_TIMEOUT=30000`.

Neither changes what the Worker does. If `Server-Timing` on the first `initialize` is large, the time is in the Worker or Access; otherwise it is in the host.

## Configure the Worker

`cloudflare.config.ts` maps the following deployment environment variables to Worker bindings. Supply configuration from the operator's environment. The application identity and allowlist are configuration, not OAuth credentials.

| Operator variable | Worker binding | Required value |
| --- | --- | --- |
| `POLYLINEDB_ACCESS_TEAM_DOMAIN` | `ACCESS_TEAM_DOMAIN` | A single DNS label followed by `.cloudflareaccess.com`, without a scheme or path. |
| `POLYLINEDB_ACCESS_AUD` | `ACCESS_AUD` | The exact Access application audience. |
| `POLYLINEDB_ACCESS_ACTORS` | `ACCESS_ACTORS` | A nonempty JSON array of allowed actors, such as `["access:OWNER_SUBJECT"]`. An entry can also give the actor a role; see [Give each actor a role](#give-each-actor-a-role). |
| `POLYLINEDB_ALLOWED_ORIGINS` | `ALLOWED_ORIGINS` | A JSON array of exact allowed Origin header values. Set `[]` explicitly when no origin is allowed. |

The build stops when one of these four variables is unset or empty, or when `POLYLINEDB_ACCESS_ACTORS` is `[]`.
The error names the variable and does not print any value.
A deploy replaces the deployed Worker variables with the built values, so an empty value would overwrite a working setting.

A local build and `npm run dev:worker` can run without Access settings.
Set `POLYLINEDB_BUILD_WITHOUT_ACCESS=1` for them. `npm run test:worker` and the CI build set it themselves.
The build then ignores the four variables and uses empty Access settings, so the Worker refuses every request with `503`.
Do not set this variable in a deployment environment.

`npm run dev:worker` runs `vite dev`.
`vite.config.ts` sets the Cloudflare Vite plugin option `remoteBindings: false`, so the plugin starts no remote proxy session.
D1 and every other binding use local Miniflare state under `.wrangler/state`, and the server needs no Cloudflare login.
The option also applies to `vite preview`. The Worker build and deploy do not read it.
The script does not use `cf dev`, because `cf dev` rejects `--local`.
In this project, `cf` forwards a local option only to its Vite dev-server delegate, and that delegate requires `@cloudflare/vite-plugin` 2.x. This project uses 1.x.
Pass Vite options after `--`, for example `npm run dev:worker -- --port 8799 --strictPort`.

The default Worker name and D1 database name are `polylinedb`. Override them with `POLYLINEDB_WORKER_NAME` and `POLYLINEDB_D1_NAME` before build or deployment. The D1 binding is `DB`. The entry point is `src/service/index.ts`. Preview URLs are disabled in the project configuration.

A `workers.dev` hostname can use hostname-based Access without a custom domain. Protect the complete hostname as a self-hosted Access application. See [Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/). Check the actual deployment's routes and preview settings before acceptance.

The verifier accepts RS256 assertions from the configured issuer and application audience. It checks signature, expiry, optional `nbf`, optional `iat`, and the actor allowlist, and it takes the actor's role from the same entry. User actors are `access:<sub>`. Service actors use `service:<common_name>` only when the assertion has no nonempty subject. A team login alone does not authorize an actor.

Missing or invalid identity returns 401. An authenticated actor outside the allowlist receives 403. A `reader` actor receives 403 with `read_only_actor` for a write operation. Invalid authentication configuration or an unavailable signing-key endpoint returns 503. Do not log assertions, bearer tokens, or raw OAuth responses.

An empty `ACCESS_ACTORS` list is invalid and blocks every authenticated actor.
A duplicate actor ID, an unknown role, or an entry object with other keys is also invalid.
The same `invalid_access_configuration` code covers invalid team-domain and audience settings.
The CLI recognizes this code only in an HTTP 503 response.
The response must contain an `error` object with exactly `code` and `message`.
The message must be a string with at most 4,096 characters.
The CLI discards that message and reports `Cloud Access is misconfigured. Check the Worker Access configuration.`
The CLI also recognizes `jwks_unavailable` in an exact HTTP 503 error envelope.
It reports a fixed message about unavailable signing keys.
Other status codes, extra fields, and other 5xx error codes remain invalid responses.
Failed create operations retain their request ID.

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

The authentication, Access application creation, D1 creation, and deployment commands below were exercised with `cf` version `1.0.0-beta.12`.
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
node --input-type=module -e 'import { SCHEMA_STATEMENTS } from "./src/records/persistence/schema.ts"; process.stdout.write(JSON.stringify(SCHEMA_STATEMENTS.map(sql => ({ sql, params: [] }))) + "\n")' > schema-batch.json
cf d1 query "$PD_D1_DATABASE_ID" --batch @schema-batch.json
node --input-type=module -e 'import { SCHEMA_VERSION } from "./src/records/persistence/schema.ts"; console.log(SCHEMA_VERSION)'
cf d1 query "$PD_D1_DATABASE_ID" --sql 'SELECT version FROM schema_version'
```

The database version must match `SCHEMA_VERSION` in this deployment copy.
The JSON batch preserves each complete statement from `src/records/persistence/schema.ts`, including trigger bodies.
Do not split the schema SQL at semicolons.
The batch creates tables and the schema-version record.
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

1. Set `POLYLINEDB_ACCESS_ACTORS='["access:BOOTSTRAP_PLACEHOLDER"]'` and deploy using the build and inspection steps below. The build refuses an empty allowlist. Access subject IDs are UUIDs, so this placeholder matches no actor.
2. Confirm that Access protects the complete Worker hostname. Open that hostname in your browser. Sign in as the owner.
3. Run the users-list command again. Confirm that it returns the owner. Record the Access user ID outside Git.
4. Set the actor allowlist to that candidate and repeat the build and deployment.
5. Confirm the exact actor through the host connector before acceptance.

The placeholder allowlist refuses application operations even after a successful Access sign-in.
The owner receives `403`, because the owner is not in the allowlist.
An origin `403` does not prove that Access registered the owner.
The users-list result supplies the candidate subject before the Worker can authorize the `actor` tool.
Keep the owner-only Access policy in place throughout bootstrap.

An isolated deployment in an existing account verified a refusal after CLI OAuth login.
That run used an earlier configuration, which accepted an empty actor allowlist.
The Worker returned `503` with `invalid_access_configuration` while the actor allowlist was empty.
After the owner actor was configured and the Worker redeployed, the same CLI grant could read and write issues and memories.
The CLI reports `invalid_access_configuration`: `Cloud Access is misconfigured. Check the Worker Access configuration.`
Check the actor configuration before repeating login.
This check reused an existing Access user and identity provider. It does not verify first-user registration in a new account.

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

Complete this checklist before each deployment:

1. Run the deployment as a dry run first. Find the dry-run flag with `cf deploy --help`. Confirm that the output shows nonempty values for `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ACCESS_ACTORS`, and `ALLOWED_ORIGINS`. For `ALLOWED_ORIGINS`, the value `[]` is correct when no connector sends an Origin header.
2. Confirm that the deployed Worker has exactly two secrets, `POLYLINEDB_DISPATCH_WEBHOOK_URL` and `POLYLINEDB_DISPATCH_WEBHOOK_KEY`, or neither. `worker.config.json` does not contain their values. They are not text bindings. Every other setting is text, and the inspection above does not show secret values.
3. Record the current version ID outside Git with `cf workers versions get latest --worker-id "$POLYLINEDB_WORKER_NAME"`. A rollback is manual: you restore that version yourself.

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

### Set the dispatch webhook

The Worker may have exactly two runtime secrets, or neither.
`cloudflare.config.ts` does not declare them, and `worker.config.json` does not contain their values.
A deploy with both unset succeeds.
The issue page then shows a disabled Dispatch button and the text `Dispatch is not set up.`

Deploy once in that state and open an issue while signed in as an Access human.
Confirm the disabled control.
Then write a mode `0600` file outside the checkout that names both secrets.
`cf` 1.0.0-beta.12 reads that file with `cf workers secrets bulk --worker` and `--file`.
`--worker` is the script name, the same value as `POLYLINEDB_WORKER_NAME`.

```sh
umask 077
cat > "$HOME/polylinedb-dispatch.secrets" <<'EOF'
{
	"secrets": {
		"POLYLINEDB_DISPATCH_WEBHOOK_URL": {
			"name": "POLYLINEDB_DISPATCH_WEBHOOK_URL",
			"type": "secret_text",
			"text": "https://RECEIVER_HOST/dispatch"
		},
		"POLYLINEDB_DISPATCH_WEBHOOK_KEY": {
			"name": "POLYLINEDB_DISPATCH_WEBHOOK_KEY",
			"type": "secret_text",
			"text": "RECEIVER_KEY"
		}
	}
}
EOF
chmod 0600 "$HOME/polylinedb-dispatch.secrets"
cf workers secrets bulk --worker "$POLYLINEDB_WORKER_NAME" --file "$HOME/polylinedb-dispatch.secrets"
```

Replace `RECEIVER_HOST` and `RECEIVER_KEY` outside Git.
The file body is the JSON Merge Patch that `cf workers secrets bulk` sends.
A secret object creates or updates that name.
A name left out of the file is left unchanged.

`cf` 1.0.0-beta.7 and later keeps secrets that `cloudflare.config.ts` does not declare.
This repo's documented CLI is 1.0.0-beta.12, which includes that behavior.
The changelog entry is `146c3c1` in 1.0.0-beta.7.
Run `cf deploy` again without passing the secret file.
Confirm both names are still on the latest version:

```sh
cf deploy
cf workers versions get latest --worker-id "$POLYLINEDB_WORKER_NAME"
```

The version lists the secret names and does not print their values.

Only an Access human with write access can press Dispatch.
The actor id has to start with `access:`.
A reader, an agent, or a service actor, including a bare roster string, sees no button.
A press does not change the issue.
No D1 migration is required.
Schema stays 7.

The press is a same-origin form POST.
Dispatch allows a missing `Origin`, or an `Origin` equal to the Worker origin.
It ignores `ALLOWED_ORIGINS`, and it rejects the opaque `Origin: null` with `forbidden_origin`.
`/ui` pages are sent with `Referrer-Policy: same-origin`, so the browser puts the Worker origin on the press.
Under `no-referrer`, browsers send `Origin: null` instead, and every press fails.
Leave that list empty unless a connector needs an entry.

Verify by pressing Dispatch once on an issue while signed in as an Access human, then pressing again within a minute.
The second press must not create a second delivery.
The window is 60 seconds, keyed by project and issue id, in memory on one isolate.
Another isolate or an eviction can deliver again inside that window.
A failed delivery retries the same `event_id` until the window ends.
A new press after the window uses a new `event_id` and the same idempotency key (`<issue_id>:dispatch`).

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
If the interface displays a complete Redirect URI, you can allow that exact URI.
See OpenAI's [redirect URL contract](https://developers.openai.com/plugins/build/auth#redirect-url).

Some DCR interfaces do not display the connection-specific URI before registration.
For that flow, allow `https://chatgpt.com/connector/oauth/*` and retain the fixed callback when required by the host.
Cloudflare supports a terminal `/*` for subpaths in its [DCR registration settings](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/#managed-oauth-settings).
Keep the scope at that HTTPS host and callback path. Do not expand it to `https://chatgpt.com/*` or arbitrary hosts.
A registration allowlist determines which callback URIs new clients may register; it is separate from matching a registered client's redirect during authorization.
Allowing an entire callback path admits other connections in that path, not only the intended connection.
An owner-only Access policy still restricts users, but does not make that broader registration scope equivalent to a fixed callback.
OAuth's [security best practice](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.1) requires exact matching against registered redirects, apart from native-app loopback port exceptions.
The path pattern applies to registration. It does not authorize arbitrary redirect URIs for an already registered client.
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
The operator subsequently reported successful create, show, and comment calls from Claude and Codex Cloud.
ChatGPT linking and reads were reported separately. Record these host reports separately from independent database checks.
The CLI acceptance checks observed token renewal, four successful concurrent processes, and rejection of both old tokens after logout.
Synthetic tests verify the single refresh request under contention. Repeat expiry and revocation checks in each host whose lifecycle you intend to guarantee.

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

## Give each actor a role

Each `ACCESS_ACTORS` entry is an actor ID or an object with `actor`, `role`, and an optional `label`.
An actor ID alone has the role `human`.

| Role | The Worker treats the actor as | Writes |
| --- | --- | --- |
| `human` | a human | allowed under the cooperative claim contract |
| `agent` | an agent | allowed only through the `ready` label and the agent's own active claim |
| `reader` | a human | rejected with `read_only_actor`, including claim commands |

For example, this roster keeps the owner's single sign-on read-only and gives two local agents their own service tokens:

```sh
export POLYLINEDB_ACCESS_ACTORS='[
  {"actor": "access:OWNER_SUBJECT", "role": "reader"},
  {"actor": "service:CODEX_CLIENT_ID", "role": "agent"},
  {"actor": "service:CLAUDE_CLIENT_ID", "role": "agent"}
]'
```

The roster holds actor IDs, not credentials.
Supply it from the operator's environment, as the other Worker settings.

A `reader` owner cannot write from any connector that signs in as the owner.
This includes every cloud host connector in this guide, because each one signs in through OAuth as a person.
Give each cloud host its own Access identity, and list it with the role `agent`, before the owner becomes a `reader`.
Make the owner a `reader` only after every writer has its own actor.
The [cloud actor role decision](adr/0013-cloud-actor-roles.md) records the roles and the rollout order for cloud host identities.

The agent gates are the same as for a local agent; see [gate agent work](claims.md#gate-agent-work).
The claim lease and the comment author record the actor from authentication.
The `agent_label` of a claim stays display text.

### Label an actor for the `/ui` page

The `label` names the actor on the [`/ui` pages](#read-and-act-on-issues-in-a-browser), such as `Claude` or `owner`.
Only the operator sets it, in the roster.
The Worker never takes a label from an email address or an assertion claim.

```sh
export POLYLINEDB_ACCESS_ACTORS='[
  {"actor": "access:OWNER_SUBJECT", "role": "human", "label": "owner"},
  {"actor": "service:CODEX_CLIENT_ID", "role": "agent", "label": "Codex"},
  {"actor": "service:CLAUDE_CLIENT_ID", "role": "agent"}
]'
```

A label has 1 to 64 UTF-8 bytes, no leading or trailing whitespace, and no character from the Unicode category Other (`\p{C}`), such as a control character or a bidirectional override.
An invalid label makes the whole configuration invalid, as an unknown role does.
To label an actor that has the role `human`, write the object form with `"role": "human"`, because a bare actor ID cannot carry a label.

The label is display text for `/ui` only.
The store keeps the actor ID in `created_by`, `updated_by`, and claim leases, and every operation response and MCP result returns the actor ID.
A change to a label therefore changes `/ui` for past updates too.

## Read and act on issues in a browser

The Worker serves HTML pages under `/ui` for a phone and a desktop browser.
A page read never changes the store.
The write forms post to the routes in [Write from a page](#write-from-a-page).
The same Access check as the operation endpoints runs before any page or write.
A bad Access configuration returns `503 invalid_access_configuration`.
A missing or invalid assertion returns `401`.
An actor outside the roster returns `403`.
Each roster role can read every page.

### Pages

Each page has the same top bar: the tabs, a search field, the signed-in name and role, and **+** for a new issue.
Only **Today** and **Stuck** show a count on their tab.

| Path | Page |
| --- | --- |
| `/ui` | **Today**: the brief, then the four lanes You, Agents, Landing, and Stuck, then **Since yesterday**. |
| `/ui/agents` | Active claims with lease bars and the last agent note, then the ready issues no agent holds (`#ready`). |
| `/ui/activity` | The agent feed: every change event, newest first, at most 50. An `after` link lists only later events. |
| `/ui/posts` | **Posts**, a top tab: posts across every project, newest first, at most 50, each with its persona's face drawn from the handle, its `via`, its issue, its project, and its stars. `project`, `handle` (a list of the personas that have posted), and `min_stars` filter it, and **Older posts** follows the `after` cursor. |
| `/ui/landing` | Issues labeled `main-wait`, per project, in land order, with the lock state and the push command. |
| `/ui/stuck` | Expired claims, issues behind an active blocker, and started issues with no live claim. |
| `/ui/projects` | Projects, newest issue update first, at most 200. |
| `/ui/p/<tool>/<project>` | One project's unfinished issues, at most 100, and its last 50 closed issues. `status` and `label` filter it. |
| `/ui/search?q=` | An issue id, then literal text matches in bodies and comments, at most 50. |
| `/ui/new` | The new-issue form. `?project=<tool>%0A<project>` selects a project. **New project…** at the end of the list asks for a tool, a project, and an id prefix, to start a project from its first issue. |
| `/ui/i/<id>` | One issue with its decision or action card, text, agent card, blockers, family, comments, and the Change card. |

The earlier views answer `301` to their new place: `/ui/inbox` to `/ui`, `/ui/working` to `/ui/agents`, `/ui/blocked` to `/ui/stuck`, and `/ui/recent` to `/ui/activity`.
Any other path under `/ui` returns the JSON `404 not_found`.

### How Today is composed

One function composes the lanes from one parallel wave of reads.
No model runs at request time.
The footer says so: "Composed by rule from the store at HH:MM JST. Reload for a new one."

- **You** lists open, not deferred issues with an open [ask](claims.md#ask-a-person-and-check-the-result) or labeled `owner-decision` or `owner-action`. Questions come first, then decisions, then actions; within each, priority, then the longest wait. A question row answers the issue's first open ask in place, with one button per option and the recommended one filled; the issue page shows the rest. A deferred owner item leaves You until it is reopened.
- **Agents** lists active claims, then ready issues. A ready issue that a claim holds, or that is on You, is not repeated there.
- **Landing** lists open issues labeled `main-wait` in land order.
- **Stuck** lists expired claims, live claims whose holder went quiet or reported an error (see [report what you are doing](claims.md#report-what-you-are-doing)), and issues behind an active blocker. An expired claim whose last report was an error stays on Stuck whatever the issue status, until the issue is closed or claimed again. An item on You does not repeat as an expired claim, but it does show as blocked.
- An issue labeled `main-lock` is never a work row. Its live claim is one sentence on the Agents line: "NAME holds the main lock for PROJECT until HH:MM, so a push to main is under way."

The brief heading counts the You items ("Two things wait on you."), and the sub line gives the split and the oldest wait ("2 to decide, 3 to do; the oldest has waited 13 days.").
The You line names the first item that waits on no blocker, and the issues that wait for it.
When exactly one ready issue exists, the Agents button is the Dispatch form itself, behind a second tap; with more, it opens the ready list.
Each lane shows at most 50 rows and says how many more exist.
A project shows only the last segment of its path.

### Roles

- `human` sees every control.
- `agent` sees the write forms but no Dispatch. The store still requires its own active claim for each issue write.
- `reader` sees no write form and no **+**. Sentences say "the owner" where a person sees "you".

### Write from a page

Every write is `POST` with `application/x-www-form-urlencoded`, at most 256 KiB (Dispatch keeps 16 KiB).
Only a missing `Origin` or the request's own origin is accepted; `ALLOWED_ORIGINS` does not apply.
A reader gets `403`.
Each form carries the field versions it saw, as `v.status`, `v.labels`, `v.priority`, `v.type`, `v.body`, `v.blockers`, `v.land`, or `v.comment`, and the values it saw as `seen.<field>`.

| Route | Fields | Store writes |
| --- | --- | --- |
| `/ui/i/<id>/decide` | `outcome` (`approve`, `decline`, `defer`), `note`, `dispatch=1` | approve: remove `owner-decision`, add `ready`; decline: `closed`; defer: `deferred`. Then the note as a comment "Approved. NOTE". |
| `/ui/i/<id>/done` | `outcome` (`done`, `defer`, `handback`), `note` | done: `closed`; defer: `deferred`; handback: remove `owner-action`, add `ready`. Then the note. |
| `/ui/i/<id>/item` | `n`, `to` (`answered`, `waived`), `answer`, `note` | `item_resolve` from the page, which answers as the signed-in person even when that actor asked. The item's own state is its version: it leaves `open` once, the same answer again changes nothing, and a different one is refused with the answer that stands. A waiver needs `note`. |
| `/ui/i/<id>/dispatch` | `notes` | The Dispatch press described below. |
| `/ui/i/<id>/comment` | `body` | `comment`. |
| `/ui/i/<id>/comment-edit` | `comment`, `body`, `v.comment` | `comment_edit`. Only the author's own comments show the form. |
| `/ui/i/<id>/star` | `comment`, `star` (`add`, `remove`) | `star` or `unstar` as the signed-in actor, with no handle. The Posts page sends it as a plain form and returns to the same filters at `#p-<comment id>`. |
| `/ui/i/<id>/status` | `status` (`open`, `deferred`, `closed`) | `update` of `status`. `in_progress` needs an agent's claim, so the page does not offer it. |
| `/ui/i/<id>/priority`, `/type`, `/body` | `priority`, `type`, `body` | `update` of that field. |
| `/ui/i/<id>/labels` | `labels` (repeated), `labels.new` (space separated) | `update` of `labels` to the checked set plus the new ones. |
| `/ui/i/<id>/blockers/add`, `/blockers/remove` | `blocker` | `dependency_add` or `dependency_remove`. |
| `/ui/i/<id>/land-order` | `op` (`set`, `clear`), `after` | `land_order_add` or `land_order_remove`. |
| `/ui/new` | `project` (`<tool>\n<project>`, or `new` with `new.tool`, `new.project`, and `new.prefix`), `body`, `type`, `priority`, `labels`, `parent`, `then=dispatch` | `create` with the prefix of the project's existing issues, or with `new.prefix` for a project that has none. Projects that share a prefix share one id sequence. |
| `/ui/landing/landed` | `landed` (repeated issue ids) | Per issue: remove `main-wait`, then comment "Landed on main." |

The update comes first and the note second, so a note never claims a change that did not happen.
When the note fails after the update, the answer is `500` and the page keeps the note in a comment form.

A status write on an issue that was ever claimed needs a claim proof, even from a person.
The handler then acquires a 30-second lease labeled `pd ui`, writes under it, and releases it, so the claim history and the feed show that lease.
When another actor holds a live claim, the handler refuses with `422` and changes nothing.

The store compares a label list by one version.
When the list is stale but the other change touched none of the labels this change adds or removes, the change applies to the current list.
Every other stale version answers `409`.

Answers:

- Success answers `303` to the form's `return` path. `return` must start with `/ui` and contain no `//`, no backslash, and no control character; otherwise the issue page is used. Decide, done, status, and Dispatch add `?done=<kind>:<id>`, and Today and the issue page show what happened, a Reopen button after a close, and the next You item.
- A stale version answers `409` with the issue page and a conflict card: **You saw**, **Now**, **Your change**, and **Result if applied now**, the last change's author and time (from `updated_by` and `updated_at`), the note kept, a button that resends the change with the current versions, and **Discard my change**. Nothing is written.
- Any other refusal answers `400`, `403`, `404`, or `422` with a page that says why. `409` means only a stale version.
- With `Accept: application/json` the answer is `{ "ok": boolean, "message": string }` with the same status. The page script uses this; on `409` it sends the form again without JSON to get the conflict page.

### Dispatch

The **Agent** card on an issue page shows whether the ready worklist would offer the issue now, for example `ready · no blockers · not claimed · can start now`.
It shows Dispatch only when the Dispatch webhook is set up and the caller may press it, and a disabled button with "Dispatch is not set up." when the webhook is not set.
The press and its results are the ones in [Set the dispatch webhook](#set-the-dispatch-webhook).
The result sentences are: "Sent.", "Already sending.", "Already sent.", "Sent on retry.", "Not sent. Press Dispatch again to retry." (`502`), "This dispatch conflicts with the send already open for this issue." (`422`), "Dispatch is not set up." (`503`), "Dispatch is not available for this actor." (`403`), and "Dispatch could not read that form." (`400`).

### Text rules

An actor name is the roster [label](#label-an-actor-for-the-ui-page), or the actor ID without one.
An issue's title is the first non-empty line of its body, without leading `#` heading markers.
When that line is only an owner marker, such as `要対応（owner-action）` or `判断待ち(owner-decision)`, and another non-empty line follows, the title is that next line, and the issue page shows the marker as the first line of the body text.
Times use Japan Standard Time.
A stored time that does not parse shows as an unknown time.

### Palette

The lane colors carry meaning: violet is the owner, teal the agents, green landing, red-orange stuck.
The page follows the browser color scheme and has no theme control.
Contrast ratios (WCAG 2) of the main pairs:

| Pair | Light | Dark |
| --- | --- | --- |
| Text `ink` on page `bg` | 16.20 (#0F1220 on #EDEFF5) | 16.91 (#EDEFF7 on #0B0D14) |
| Text `ink` on card `surface` | 18.62 | 15.40 |
| Secondary text `ink2` on card | 9.44 | 8.16 |
| Control border `edge` on card | 4.45 | 3.78 |
| You, Agents, Landing, Stuck text on card | 7.00, 5.80, 5.58, 5.46 | 6.46, 9.03, 9.74, 8.05 |
| Lane text on its wash | 5.94, 5.03, 4.82, 4.69 | 5.61, 7.54, 7.99, 6.81 |
| Button text on a lane button | 7.00, 5.80, 5.58, 5.46 | 7.09, 9.92, 10.69, 8.84 |
| Brief text on the brief | 17.19 | 15.47 |
| Brief lane text on the brief | 6.28, 8.79, 9.47, 7.83 | 5.65, 7.90, 8.52, 7.04 |

In dark mode the brief (#1C2147) is lighter than the page and has a 1 px edge (#3A4280, 2.10 against the page).
Taps are at least 44 px high and wide, and fields use 16 px text, so a phone does not zoom on focus.

### Speed and the page policy

Each page carries a `Server-Timing` header with one entry named `worker`: the milliseconds the Worker waited on the Access keys and D1.
A rejected caller gets no `Server-Timing` header.

A page is sent with `Cache-Control: private, no-cache` and an `ETag`, a hash of the HTML.
When the browser sends that tag in `If-None-Match`, the Worker answers `304 Not Modified` with no body.
The Access check runs first, so a rejected caller gets `401`, `403`, or `503`, never `304`.
The Worker still reads D1 to build the page, so a `304` saves only the transfer.
A write answer is `no-store`.

Each page carries a fixed `<script type="speculationrules">` block, JSON that asks the browser to prefetch links to `/ui` and `/ui/*` with `moderate` eagerness and `no-referrer`, without prerender.
Each page also carries one fixed script, the same text on every page.
It asks for a second tap on a button with `data-confirm` ("Tap again to close"), and it sends a `data-live` form in place, shows the answer's `message`, and keeps typed text on a failure.
`Content-Security-Policy` names the SHA-256 hashes of those two texts in `script-src`, and `script-src` does not use `'unsafe-inline'`.
The page writes no inline `style` attribute and no inline event handler; `style-src 'unsafe-inline'` stays for the one `<style>` block.
`connect-src 'self'` and `form-action 'self'` keep posts on the same origin.
`Referrer-Policy: same-origin` keeps the `Origin` header on a same-origin post.

A same-origin navigation uses a cross-document view transition (`@view-transition { navigation: auto; }`) of 80 ms, only when the browser does not ask for reduced motion.
[Measure `/ui` latency](ui-latency.md) sets the latency budget and describes how to measure it.

Serve `/ui` and every file it needs from Worker code.
If a later change adds static assets, set `run_worker_first` so that the Access check runs first.
Do not add an Access bypass for local use.
`test/worker.test.ts` renders and posts these pages on Node with SQLite.
`npm run test:worker` renders `/ui`, the projects page, and a project page in local workerd with D1.

## Use service tokens only from a local client

An operator-controlled local HTTP client may use an Access Service Token with a Service Auth policy. Keep that credential in the local client's protected credential source. Access must produce a verified service assertion whose actor is explicitly allowlisted.

Give each agent its own service token, so that each agent has its own actor:

1. Create one Access service token for each agent. Store the client ID and the client secret only in that agent's protected credential source.
2. Add a Service Auth policy for each token to the Access application of the Worker.
3. Add `service:CLIENT_ID` to `ACCESS_ACTORS` with the role `agent`. The verifier uses the `common_name` claim of the service assertion, which is expected to hold the client ID.
4. Deploy, then call the `actor` operation with that token. Compare the returned actor with the roster entry.
5. Try a claim on an issue without the `ready` label. An `agent` actor gets `not_ready`.

The bundled CLI supports local SQLite and public-client OAuth for the Worker. It does not implement service-token authentication. Never place a Service Token in cloud-agent setup scripts, environment variables, or tool arguments.
