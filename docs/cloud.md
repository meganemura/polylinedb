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

A successful `codex mcp login` on a laptop proves that local connection. A local IDE MCP configuration likewise proves that IDE connection. Neither result establishes token storage or tool availability inside a cloud task. Do not copy a local OAuth credential file into a cloud sandbox to bridge this gap.

If the selected cloud product cannot broker the connection without exposing credentials to its agent, keep that host unavailable. A service token inside its VM does not meet this connection boundary.

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

`npm run dev:worker` runs `vite dev` with `CLOUDFLARE_VITE_FORCE_LOCAL=true`.
The Cloudflare Vite plugin then turns off remote bindings and starts no remote proxy session.
D1 and every other binding use local Miniflare state under `.wrangler/state`, and the server needs no Cloudflare login.
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
node --input-type=module -e 'import { SCHEMA_STATEMENTS } from "./src/records/schema.ts"; process.stdout.write(JSON.stringify(SCHEMA_STATEMENTS.map(sql => ({ sql, params: [] }))) + "\n")' > schema-batch.json
cf d1 query "$PD_D1_DATABASE_ID" --batch @schema-batch.json
node --input-type=module -e 'import { SCHEMA_VERSION } from "./src/records/schema.ts"; console.log(SCHEMA_VERSION)'
cf d1 query "$PD_D1_DATABASE_ID" --sql 'SELECT version FROM schema_version'
```

The database version must match `SCHEMA_VERSION` in this deployment copy.
The JSON batch preserves each complete statement from `src/records/schema.ts`, including trigger bodies.
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
2. Confirm that the deployed Worker has no secrets. This configuration supplies every setting as text, and the inspection above does not show secrets.
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

The `label` names the actor on the [`/ui` page](#read-recent-work-in-a-browser), such as `Claude` or `owner`.
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

## Read recent work in a browser

The Worker serves a read-only page at `/ui` for a phone browser.
The page lists two sections:

- `main 待ち`: open issues with the label `main-wait`. This label marks work that is merged into a local land queue but is not yet on the remote main branch.
- `Recently closed`: closed issues.

Each row shows the issue ID, the first line of the body, the time of the last update in JST, and the actor of the last update.
The actor shows as its roster [label](#label-an-actor-for-the-ui-page), or as the actor ID when the roster gives it no label or no longer lists it.
The rows are newest first by `updated_at`.
The time column has the label `最終更新`.
It is not the close time, because the store does not record when an issue closed or who closed it.
A comment does not change `updated_at`.

The Worker code returns the page only after the same Access verification as the operation endpoints.
A bad Access configuration returns `503 invalid_access_configuration`, a missing or invalid assertion returns `401`, and an actor outside the roster returns `403`.
Each roster role can read the page.
The page has no form and no script, and `/ui` accepts only `GET`.
Serve `/ui` and every file it needs from Worker code. If a later change adds static assets, set `run_worker_first` so that the Access check runs first.

Do not add an Access bypass for local use.
`test/worker.test.ts` renders `/ui` on Node with SQLite, and `npm run test:worker` renders it in local workerd with D1.
Both sign a test assertion and check the page content.

## Use service tokens only from a local client

An operator-controlled local HTTP client may use an Access Service Token with a Service Auth policy. Keep that credential in the local client's protected credential source. Access must produce a verified service assertion whose actor is explicitly allowlisted.

Give each agent its own service token, so that each agent has its own actor:

1. Create one Access service token for each agent. Store the client ID and the client secret only in that agent's protected credential source.
2. Add a Service Auth policy for each token to the Access application of the Worker.
3. Add `service:CLIENT_ID` to `ACCESS_ACTORS` with the role `agent`. The verifier uses the `common_name` claim of the service assertion, which is expected to hold the client ID.
4. Deploy, then call the `actor` operation with that token. Compare the returned actor with the roster entry.
5. Try a claim on an issue without the `ready` label. An `agent` actor gets `not_ready`.

The bundled CLI supports local SQLite and public-client OAuth for the Worker. It does not implement service-token authentication. Never place a Service Token in cloud-agent setup scripts, environment variables, or tool arguments.
