# Human exception board

Status: proposed design. Room consensus 2026-10-07.

pd is cloud-agent-first. Humans need a small trust and exception surface, not a general issue tracker. The same UI works against local SQLite and against Cloudflare (the Worker). The UI does not learn which store sits behind the API.

This memo is the handoff for that surface. It depends on the [issue authority design](issue-authority.md) and the [authority decision](adr/0011-issue-authority-layers.md). It supersedes the earlier pd-17 framing that treated issue list, search, and detail as the primary human product. List and search remain secondary drill-down only.

## Purpose

Agents create issues, claim them, and close them through the CLI and MCP. A person opens this UI to see where that work stalled and to take a narrow action. The home screen is an exception board: summary counts and the rows that need a person.

One UI talks to one API. Locally the store is a SQLite file. On Cloudflare today the authority is still D1. In release 0.5 the live cloud store is the store Durable Object, and D1 holds the projection. The UI sends the same requests in every case. The full Durable Object cutover stays on epic pd-51. The first UI can run against today's SQLite and D1 authority, and the live-versus-projection split wires in as that epic lands.

## Non-goals

1. Do not put a human status or assignee kanban, or a drag-reorder board, on the home screen.
2. Do not build "a person writes a ticket and assigns it to an agent" create or edit flows first. Issue creation and status editing stay on the CLI and MCP.
3. The UI must not touch Durable Object SQL or D1 directly. Human mutations go only through the existing transition and mutation API: release and force reclaim. Fencing must not be bypassed.
4. No second source of truth. Do not copy the authority database into a viewer-only database.

## Read paths

Live exception, lease, and current revoke-miss views read the authority. In release 0.5 that authority is the store Durable Object. Today the local authority is SQLite, and the cloud authority is still D1. Lag on this path would make the trust surface lie, because a person would act on authority the store has already removed.

`reconcile_runs` history and trends read the D1 projection, as the [issue authority design](issue-authority.md#cold-reconciliation-targets-zero-missed-revocations-first) specifies. Local SQLite serves both mouths from one file: the live rows and the run history live in that file together.

The UI calls the API. The backend chooses SQLite or the Durable Object.

A missed revocation is the case the authority design already names: the projection still shows authority that the store has removed. An example is a released claim that the projection still shows as active. The board shows the current miss from the authority. The trend of misses comes from `reconcile_runs`.

## Home screen

The home screen is the exception board. It shows summary counts and only the rows that need human attention:

- abandoned or in-progress claims
- expired leases that are not yet reclaimed
- the current projection revoke-miss and reconcile failures
- agent handoff breaks (a stale session or a stale store incarnation)

Each exception row shows the actor, the session, and the store incarnation. Those three fields say who held authority when the work stalled. The row also says what stalled.

## Four feature areas

Version 1 has four areas. The exception queue and the trust panel are why the UI exists. The results surface is a review of agent output. Drill-down is secondary and is not the home screen.

### 1. Exception queue

Opening a row shows the proof, the session, `expires_at`, and the last mutation. Human actions on that row are limited to release, force reclaim, and comment.

Release and force reclaim go through the transition and mutation API. The UI does not write `released_at`, `reclaimed_at`, or the public claim state itself. The authority design already fixes the reclaim record: the reclaim role writes `reclaimed_at` and leaves `released_at`, the revision, and the public state `expired` unchanged. A reclaim that writes `released_at` would turn `expired` into `released` and erase the difference between a deliberate release and a lapsed lease. Force-reclaim semantics for a human action stay inside that rule. The exact command is an open question below.

### 2. Trust panel

The panel shows recent `reconcile_runs`: success or failure, missed revocations, and the reclaim success rate. A failing run opens its detail. Trends come from the D1 projection. Live misses come from the authority.

Each run row records start and end, result, failure class, missed revocation count, repair counts, sequence gaps, and reclaim counts. ADR 0011 records the same measures. The table is an operator record today and is outside the CLI, HTTP, and MCP contract. This UI is the human reader of that record. The projection stays a reader of authority, and the panel does not become a writer of issue state.

### 3. Results surface

The results surface shows review-needed and Done diffs from agents. It is a review of finished agent work. It is not a ready-column kanban, and it is not the home screen. Whether it needs new projection fields or only existing statuses is an open question.

### 4. Drill-down

Issue show, the dependency graph, and search are secondary. A person reaches them from an exception or a result. They are not the product the home screen is built around.

## API skeleton

The UI sees three shapes. They are the same locally and on Cloudflare. The backend hides SQLite versus the Durable Object.

| Shape | Source | What the UI uses it for |
| --- | --- | --- |
| Exception list | Live authority | Home counts and exception rows, including actor, session, and store incarnation |
| Lease and claim state | Live authority | The open row: proof, session, `expires_at`, and the last mutation |
| Reconcile history | D1 projection, or the same local SQLite file | Trust-panel runs and trends |

Human mutations are not a fourth store. Release and force reclaim call the transition and mutation API, so the proof, the actor, the session, the incarnation, and the deadline stay inside the transition. Comments, if the UI offers them, call the existing comment mutation. The UI does not send SQL.

## Delivery

On Cloudflare, the same Worker serves the static UI and these APIs, with Cloudflare Access in front. Prefer that one Worker over a second viewer Worker for version 1. The browser does not hold a service token.

Locally, `wrangler dev` or a UI process calls the same API shapes against the local store.

The deployed Cloudflare UI reads the Cloudflare store only. A local UI reads the local store through the same shapes, and it can also call the Cloudflare API. The Cloudflare UI does not open a local SQLite file. Verify three paths: the deployed UI against Cloudflare, the local UI against local SQLite, and the local UI against Cloudflare. Access stays in front of the deployed UI.

Version 1 updates by polling every few seconds. A later option is a Worker WebSocket that uses Durable Object hibernation, or server-sent events, and then only for rows that changed. Concurrent human viewers are expected to be few. One store Durable Object has a soft limit of about 1,000 requests per second. This UI stays inside that budget. The figure comes from the authority design; measure the personal store before treating it as a commitment.

## Relation to other documents

- The [issue authority design](issue-authority.md) defines the store Durable Object, the D1 projection, reclaim versus the sender alarm, `reclaimed_at`, the public state `expired`, and `reconcile_runs`.
- [ADR 0011](adr/0011-issue-authority-layers.md) records those choices. Release 0.5 uses one store object. The reclaim role writes `reclaimed_at` and leaves the public state `expired`. Each reconciliation run is one `reconcile_runs` row in the D1 projection database.
- Issue pd-17 tracks this surface. This memo supersedes the earlier pd-17 framing that centered on issue list, search, and detail as the primary human product.
- Epic pd-51 tracks the Durable Object cutover. This UI does not implement that cutover.

## Open questions

Leave these explicit. The first UI does not close them by guessing.

1. The exact exception-row schema and the priority ordering of rows.
2. Force-reclaim semantics versus the public state `expired` versus `reclaimed_at`. The answer stays aligned with the issue authority design: reclaim records `reclaimed_at` and does not turn `expired` into `released`.
3. Whether a comment from the UI uses the existing comment mutation, and which actor identity that comment carries.
4. Auth: which actor an Access session becomes for a human release, force reclaim, or comment.
5. Whether the results surface needs new projection fields or only existing statuses.

## Handoff

The receiving agent should:

1. Read this memo, issue pd-17, and [the issue authority design](issue-authority.md). Read [ADR 0011](adr/0011-issue-authority-layers.md) for the Durable Object, D1, reclaim, and `reconcile_runs` decisions.
2. Implement API stubs and a static UI against the three shapes in the API skeleton.
3. Keep human mutations on the transition and mutation API. Do not add a path that writes Durable Object SQL or D1 from the UI, and do not bypass fencing.
4. Keep the home screen as the exception board. Do not invent a ticket board, a status kanban, or a human create-and-assign flow as the home screen.
