# Secure MCP Tunnel feasibility

Reviewed on October 3, 2026. This is a research result, not a tested tunnel deployment.
Keep the public HTTPS MCP endpoint with Cloudflare Access as the current connection path.
Secure MCP Tunnel is a candidate for a later private connection, subject to the checks below.
This investigation installed no client, registered no tunnel, and changed no authentication or deployment.

## What the tunnel changes

An owner-controlled `tunnel-client` process retrieves MCP requests from OpenAI, forwards them to its configured server, and sends responses back.
The client needs outbound HTTPS to OpenAI on port 443 and connectivity to the MCP server.
The tunnel itself needs no inbound listener.
Deployment examples use Docker, Kubernetes, or a VM service. See OpenAI's [deployment overview](https://github.com/openai/tunnel-client/blob/master/docs/deployment/overview.md).

The client must remain available for discovery and tool calls.
OpenAI documents HTTP and stdio targets, a runtime API key, and optional control-plane mTLS.
OAuth discovery can pass through the tunnel, but the authorization server is not automatically tunneled.
Codex is a named supported product, while its exact product connection mechanism still needs verification.
See the [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

Adding a tunnel target to an existing public Worker does not make that Worker private.
That conclusion follows from the proposed topology: the existing HTTPS route remains deployed while another client calls it.
Keep Access protection on that route.
The bundled `cloudflared` companion provides an additional Cloudflare tunnel runtime, rather than a replacement for a Worker's Access policy.
Its deployment documentation describes the companion process and runtime token. See [Cloudflare companion deployment](https://github.com/openai/tunnel-client/blob/master/docs/deployment/cloudflared.md).

## Fit with polylinedb

| Candidate | Required polylinedb work | Authentication condition |
| --- | --- | --- |
| HTTP target at the existing Worker `/mcp` | Start with configuration and a compatibility probe. No application change is justified before that probe. | Preserve Access OAuth, the signed assertion, and the actor allowlist. |
| Private HTTP server backed by SQLite | Add an HTTP runtime around existing operations and define its authentication boundary. | A tunnel identifier cannot supply a trusted issue actor. |
| Local stdio server backed by SQLite | Add a persistent MCP stdio adapter. The current `pd` process handles CLI commands. | Define who can call the adapter and how it assigns the audit actor. |

These assessments use the Worker entry point (`src/service/index.ts`), CLI boundary (`src/cli.ts`), and shared operations (`src/records/index.ts`).
These source files are available in the GitHub checkout.
The existing Worker serves HTTP MCP and calls D1.
An HTTP target is therefore the smallest candidate to test.
The external client would run on an owner-controlled host that can reach the Worker, rather than inside the Worker handler.
This deployment assessment uses the client's [HTTP and stdio binding contract](https://github.com/openai/tunnel-client/blob/master/docs/connectors.md).

`createAccessVerifier` in `src/service/access.ts` reads `Cf-Access-Jwt-Assertion` and checks its signature, issuer, audience, and time claims.
It then checks the actor allowlist.
The Worker derives user actors as `access:<sub>` and service actors as `service:<common_name>`.
An OpenAI runtime key or tunnel permission does not satisfy those checks.
Calling the Worker without a valid Access assertion continues to fail.
Do not remove authentication, trust a caller-provided actor, or fabricate an assertion to accommodate a tunnel.

The client forwards connector `Authorization` headers to its MCP target.
It also forwards OAuth discovery requests.
These documented behaviors make an Access-protected HTTP target plausible; they do not prove compatibility with Access Managed OAuth.
See [connector behavior](https://github.com/openai/tunnel-client/blob/master/docs/connectors.md#oauth-protected-connector-behavior).
The [cloud setup example](cloud.md#create-the-access-application-and-owner-policy) allows Cursor's callback only.
An OpenAI host would need its own exact, documented callback registration.

## Keep credentials outside the agent

The proposed boundary places the daemon on an owner-controlled host outside the cloud agent's VM.
The daemon host stores the runtime key and any operator-provided MCP credentials.
The product's managed connector stores user OAuth credentials.
The model and sandbox receive tools and results, not secrets, credential files, or an environment containing keys.
This is a deployment requirement, not a property established merely by choosing a tunnel.

The client supports `env:` and `file:` secret references and separates MCP headers from control-plane headers.
Connector-forwarded headers override static MCP headers.
OAuth discovery on another origin requires an explicit trusted origin.
See [client configuration](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md#connector-and-mcp-routing).
Secret references belong in the isolated daemon's private configuration, not in an agent-readable checkout or cloud setup script.
Keep the local admin interface on loopback, and inspect support exports before sharing them.

Tunnel runtime principals need Tunnels Read and Use.
Tunnel managers need Read and Manage.
The client documentation recommends a restricted runtime key and keeps the admin key separate from the daemon.
Platform organization and ChatGPT workspace associations determine where the tunnel can appear.
See [tunnel permissions](https://github.com/openai/tunnel-client/blob/master/docs/permissions.md).

## Product and account boundaries

| Product | Documented connection | What remains to establish |
| --- | --- | --- |
| Responses API | An MCP tool uses `tunnel_id` rather than `server_url` for a tunnel. An OAuth token can be needed separately. | Application-owned credential handling, Access compatibility, and account permissions. |
| ChatGPT developer mode | Choose Tunnel when creating the app and select or enter its tunnel ID. | Availability in the selected account, workspace association, and Access OAuth linking. |
| Codex | The tunnel guide names Codex. The client also documents local Codex runtime supervision and plugin commands. | The exact Codex Cloud connection controls and credential isolation in a hosted task. |
| Public plugin distribution | The plugin test guide distinguishes tunnel testing from public HTTPS submission requirements. | A tunnel does not replace the public endpoint required for submission. |

Sources are the [Responses MCP guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp), [ChatGPT plugin connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt), and [client's Codex guidance](https://github.com/openai/tunnel-client#for-codex--copilot).
A local Codex runtime result would not establish the Codex Cloud row.

ChatGPT developer-mode access depends on the account and workspace policy.
OpenAI's [ChatGPT overview](https://learn.chatgpt.com/chatgpt) lists developer-mode MCP for Plus and Pro.
That feature description does not establish tunnel entitlement for a particular account.
Platform tunnel permissions are a separate requirement.
Exact plan entitlement, tunnel pricing, transport quotas, and service guarantees remain unresolved in this review.
Responses MCP usage limits apply to that API path; do not treat them as tunnel throughput or availability guarantees.
The [stdio binding contract](https://github.com/openai/tunnel-client/blob/master/docs/connectors.md#stdio-binding) permits one active client per tunnel ID.
Restarts must avoid overlapping clients.
Use the [plugin connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt#enable-developer-mode) and [Responses usage notes](https://developers.openai.com/api/docs/guides/tools-connectors-mcp#usage-notes) when checking the selected account.

## Smallest later verification

This is a proposed experiment. Resource creation, installation, registration, and remote mutations need separate approval.

1. Select one product, account, and workspace. Verify its tunnel controls and permissions before changing polylinedb.
2. Use a dedicated, isolated daemon host and a disposable test project. Keep all keys and environment-specific configuration outside Git and the agent VM.
3. Configure an HTTP target at the existing Access-protected Worker. Preserve JWT verification and allowlisting. Configure only the required OAuth origins and callback.
4. Confirm daemon readiness, forwarded discovery, owner OAuth linking, `actor`, and `show`. Verify that the actor matches the existing Access identity.
5. Exercise `create`, `comment`, and field conflicts. Independently compare persisted D1 records and audit actors.
6. Test another hosted session, actual token expiry and refresh, revocation, and daemon interruption. Verify that unauthorized users remain denied.
7. Confirm that prompts, tool arguments, sandbox files, and sandbox environment contain no credentials. Keep product-specific results separate.

If the unchanged Worker fails the compatibility probe, identify the protocol mismatch before proposing code.
If a private local store becomes the goal, design its MCP runtime and actor boundary as a separate feature.
The public MCP connection remains the current path while these results are pending.
