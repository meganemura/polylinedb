/** Renders the read-only /ui pages for phones. They have no form, script, or write path; changes go through the operation endpoints. */
import { activeClaimIssues, blockedIssues, claimDisplay, executeOperation, issueChildren, issueParent, issuesAwaitingMain, ownerInboxIssues, parseIssueId, projectClosedIssues, projectIssues, projectSummaries, recentUpdates, PolylinedbError, type ActiveClaimIssue, type Actor, type BlockedIssue, type ClaimDisplay, type Comment, type Issue, type IssueLink, type ProjectIssue, type ProjectSummary, type Status } from '../records/index.ts';
import type { SqlExecutor } from '../records/persistence.ts';

const listLimit = 50;
const projectSummaryLimit = 201;
const shownProjects = 200;
const projectIssueLimit = 101;
const shownProjectIssues = 100;
const childLimit = 101;
const shownChildren = 100;
const attentionLabels = ['ready', 'ready-for-land-queue', 'main-wait', 'main-lock', 'owner-decision', 'owner-action'] as const;

export type UiRoute = { page: 'home' } | { page: 'inbox' } | { page: 'search'; query: string } | { page: 'working' } | { page: 'blocked' } | { page: 'recent' } | { page: 'project'; tool: string; project: string; status?: Status; label?: string } | { page: 'issue'; id: string };
const inboxLabels = ['owner-decision', 'owner-action', 'main-wait'] as const;
const viewLinks: readonly (readonly [string, string])[] = [['/ui', 'Projects'], ['/ui/inbox', 'Inbox'], ['/ui/working', 'Working'], ['/ui/blocked', 'Blocked'], ['/ui/recent', 'Recent'], ['/ui/search', 'Search']];
const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Fixed prefetch hint. It is not application code: the page policy allows this text by hash and no other script.
const speculationRules = '{"prefetch":[{"source":"document","where":{"or":[{"href_matches":"/ui"},{"href_matches":"/ui/*"}]},"eagerness":"moderate","referrer_policy":"no-referrer"}]}';

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => escapes[character] ?? character);
}

function title(body: string): string {
  const line = body.split('\n').map(text => text.trim()).find(text => text.length > 0) ?? '';
  return line.replace(/^#+\s*/, '') || line;
}

// Workers run in UTC and Japan has no daylight saving time, so a fixed offset avoids output that differs with the runtime's ICU data.
function japanTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return `${new Date(time + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')} JST`;
}

function row(issue: Issue, labels: ReadonlyMap<string, string>): string {
  return `<li class="quiet-row">
<span class="primary">${escape(title(issue.body))}</span>
<span class="secondary">${escape(issue.id)} · Last updated <time datetime="${escape(issue.updated_at)}">${escape(japanTime(issue.updated_at))}</time></span>
<span class="secondary">${escape(labels.get(issue.updated_by) ?? issue.updated_by)}</span>
</li>`;
}

function section(heading: string, issues: readonly Issue[], labels: ReadonlyMap<string, string>, empty: string, note?: string): string {
  const notice = note === undefined ? '' : `<p class="section-note">${note}</p>`;
  const body = issues.length === 0 ? `<p class="quiet-note">${empty}</p>` : `<ul class="quiet-list">${issues.map(issue => row(issue, labels)).join('')}</ul>`;
  return `<section class="quiet-section"><h2>${heading}</h2>${notice}${body}</section>`;
}

function projectHref(tool: string, project: string): string {
  return `/ui/p/${encodeURIComponent(tool)}/${project.split('/').map(segment => encodeURIComponent(segment)).join('/')}`;
}

function projectSummaryItem(summary: ProjectSummary): string {
  const counts = summary.counts;
  return `<li class="quiet-row"><a href="${escape(projectHref(summary.tool, summary.project))}">
<span class="primary">${escape(summary.tool)}</span>
<span class="secondary">${escape(summary.project)}</span>
<span class="secondary">open ${counts.open} · in_progress ${counts.in_progress} · deferred ${counts.deferred} · closed ${counts.closed}</span>
<span class="secondary">Updated <time datetime="${escape(summary.updatedAt)}">${escape(japanTime(summary.updatedAt))}</time></span>
</a></li>`;
}

function projectsSection(summaries: readonly ProjectSummary[], more: boolean): string {
  const note = more ? '<p class="section-note">More projects are not shown.</p>' : '';
  const body = summaries.length === 0 ? '<p class="quiet-note">No projects yet.</p>' : `<ul class="quiet-list">${summaries.map(projectSummaryItem).join('')}</ul>`;
  return `<section class="quiet-section"><h2>Projects</h2>${note}${body}</section>`;
}

function attention(labels: readonly string[]): string {
  const shown = attentionLabels.filter(label => labels.includes(label));
  return shown.length === 0 ? '' : `<span class="secondary">${shown.map(label => escape(label)).join(' ')}</span>\n`;
}

function issueHref(id: string): string {
  return `/ui/i/${encodeURIComponent(id)}`;
}

function japanTimeFromSeconds(seconds: number): string {
  return japanTime(new Date(seconds * 1000).toISOString());
}

function person(actor: string, labels: ReadonlyMap<string, string>): string {
  return labels.get(actor) ?? actor;
}

function activeClaim(claim: ClaimDisplay, labels: ReadonlyMap<string, string>): string {
  if (claim.state !== 'active') return '';
  const agent = claim.agentLabel === null ? '' : `<span class="secondary">${escape(claim.agentLabel)}</span>\n`;
  const at = new Date(claim.expiresAt * 1000).toISOString();
  return `${agent}<span class="secondary">${escape(person(claim.actor, labels))}</span>
<span class="secondary"><time datetime="${escape(at)}">${escape(japanTimeFromSeconds(claim.expiresAt))}</time></span>
`;
}

function projectIssueItem(row: ProjectIssue, labels: ReadonlyMap<string, string>): string {
  const { issue } = row;
  const blocked = row.openBlockers > 0 ? `<span class="secondary">blocked ${row.openBlockers}</span>\n` : '';
  return `<li class="quiet-row"><a href="${escape(issueHref(issue.id))}">
<span class="primary">${escape(title(issue.body))}</span>
<span class="secondary">${escape(issue.status)}</span>
<span class="secondary">priority ${issue.priority}</span>
<span class="secondary">${escape(issue.type)}</span>
${attention(issue.labels)}${activeClaim(row.claim, labels)}${blocked}<span class="secondary">${escape(issue.id)}</span>
</a></li>`;
}

function bodyAfterTitle(body: string): string {
  const lines = body.split('\n');
  const index = lines.findIndex(line => line.trim().length > 0);
  return index < 0 ? '' : lines.slice(index + 1).join('\n');
}

function commentItem(comment: Comment, labels: ReadonlyMap<string, string>): string {
  return `<li class="quiet-row">
<span class="secondary"><time datetime="${escape(comment.created_at)}">${escape(japanTime(comment.created_at))}</time></span>
<span class="secondary">${escape(labels.get(comment.created_by) ?? comment.created_by)}</span>
<div class="prose">${escape(comment.body)}</div>
</li>`;
}

function detailClaim(claim: ClaimDisplay, labels: ReadonlyMap<string, string>): string {
  if (claim.state === 'never_claimed') return '<span class="secondary">never_claimed</span>';
  const at = claim.state === 'released' && claim.releasedAt !== null ? claim.releasedAt : claim.expiresAt;
  const iso = new Date(at * 1000).toISOString();
  const agent = claim.agentLabel === null ? '' : `\n<span class="secondary">${escape(claim.agentLabel)}</span>`;
  return `<span class="secondary">${escape(claim.state)}</span>${agent}
<span class="secondary">${escape(person(claim.actor, labels))}</span>
<span class="secondary"><time datetime="${escape(iso)}">${escape(japanTimeFromSeconds(at))}</time></span>`;
}

function blockerItem(blocker: { id: string; status: Status }): string {
  return `<li class="quiet-row"><span class="secondary"><a href="${escape(issueHref(blocker.id))}">${escape(blocker.id)}</a></span>
<span class="secondary">${escape(blocker.status)}</span></li>`;
}

function blockerSection(heading: string, blockers: readonly { id: string; status: Status }[], empty: string): string {
  const body = blockers.length === 0 ? `<p class="quiet-note">${empty}</p>` : `<ul class="quiet-list">${blockers.map(blockerItem).join('')}</ul>`;
  return `<section class="quiet-section"><h2>${heading}</h2>${body}</section>`;
}

function familyItem(link: IssueLink): string {
  return `<li class="quiet-row"><a href="${escape(issueHref(link.id))}">
<span class="primary">${escape(title(link.body))}</span>
<span class="secondary">${escape(link.id)}</span>
<span class="secondary">${escape(link.status)}</span>
</a></li>`;
}

function parentLine(parent: IssueLink | null): string {
  if (parent === null) return '';
  return `<p>Parent <a href="${escape(issueHref(parent.id))}">${escape(title(parent.body))}</a> <span class="secondary">${escape(parent.status)}</span></p>`;
}

function childrenSection(children: readonly IssueLink[], more: boolean): string {
  const extra = more ? '<p class="section-note">More issues are not shown.</p>' : '';
  const body = children.length === 0 ? '<p class="quiet-note">No children.</p>' : `<ul class="quiet-list">${children.map(familyItem).join('')}</ul>`;
  return `<section class="quiet-section"><h2>Children</h2>${extra}${body}</section>`;
}

function detailPage(issue: Issue, comments: readonly Comment[], claim: ClaimDisplay, blockers: readonly { id: string; status: Status }[], parent: IssueLink | null, children: readonly IssueLink[], moreChildren: boolean, labels: ReadonlyMap<string, string>): string {
  const labelLine = issue.labels.length === 0 ? '<span class="secondary">No labels.</span>' : `<span class="secondary">${issue.labels.map(label => escape(label)).join(' ')}</span>`;
  const commentList = comments.length === 0 ? '<p class="quiet-note">No comments.</p>' : `<ul class="quiet-list">${comments.map(comment => commentItem(comment, labels)).join('')}</ul>`;
  const open = blockers.filter(blocker => blocker.status !== 'closed');
  const closed = blockers.filter(blocker => blocker.status === 'closed');
  return document(title(issue.body), `<p><a href="${escape(projectHref(issue.tool, issue.project))}">Project</a></p>
<h1>${escape(title(issue.body))}</h1>
<span class="secondary">${escape(issue.id)}</span>
<span class="secondary">${escape(issue.status)}</span>
<span class="secondary">${escape(issue.type)}</span>
<span class="secondary">priority ${issue.priority}</span>
<span class="secondary">${escape(issue.tool)}</span>
<span class="secondary">${escape(issue.project)}</span>
${labelLine}
${detailClaim(claim, labels)}
${parentLine(parent)}
${childrenSection(children, moreChildren)}
<div class="prose">${escape(bodyAfterTitle(issue.body))}</div>
<section class="quiet-section"><h2>Comments</h2>${commentList}</section>
${blockerSection('Open blockers', open, 'No open blockers.')}
${blockerSection('Closed blockers', closed, 'No closed blockers.')}`);
}

function notFoundPage(): string {
  return document('Not found', `<h1>Not found</h1>
<p class="quiet-note">Issue was not found.</p>`);
}

export function uiNotFoundResponse(): Response {
  return new Response(notFoundPage(), { status: 404, headers: htmlHeaders });
}

function viewNav(): string {
  return `<nav class="views">${viewLinks.map(([href, label]) => `<a href="${href}">${label}</a>`).join('')}</nav>`;
}

function document(pageTitle: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f5f1e8">
<meta name="theme-color" content="#1c1916" media="(prefers-color-scheme: dark)">
<meta name="robots" content="noindex">
<title>${escape(pageTitle)}</title>
<link rel="icon" href="data:,">
<script type="speculationrules">${speculationRules}</script>
<style>${styles}</style>
</head>
<body>
<main class="paper">
${viewNav()}
${body}
</main>
</body>
</html>`;
}

export function uiPage(lists: { projects: readonly ProjectSummary[]; moreProjects: boolean; awaitingMain: readonly Issue[] }, labels: ReadonlyMap<string, string>): string {
  return document('Projects', `<h1>Projects</h1>
${projectsSection(lists.projects, lists.moreProjects)}
${section('Waiting for main', lists.awaitingMain, labels, 'Nothing is waiting for main.', 'Open issues with the main-wait label.')}`);
}

function inboxItem(issue: Issue): string {
  const shown = inboxLabels.filter(label => issue.labels.includes(label));
  return `<li class="quiet-row"><a href="${escape(issueHref(issue.id))}">
<span class="primary">${escape(title(issue.body))}</span>
<span class="secondary">${escape(issue.id)}</span>
<span class="secondary">${escape(issue.status)}</span>
<span class="secondary">${escape(issue.tool)}</span>
<span class="secondary">${escape(issue.project)}</span>
${shown.length === 0 ? '' : `<span class="secondary">${shown.map(label => escape(label)).join(' ')}</span>\n`}<span class="secondary">Last updated <time datetime="${escape(issue.updated_at)}">${escape(japanTime(issue.updated_at))}</time></span>
</a></li>`;
}

function searchItem(issue: Issue): string {
  return `<li class="quiet-row"><a href="${escape(issueHref(issue.id))}">
<span class="primary">${escape(title(issue.body))}</span>
<span class="secondary">${escape(issue.id)}</span>
<span class="secondary">${escape(issue.status)}</span>
<span class="secondary">${escape(issue.project)}</span>
</a></li>`;
}

function searchPage(query: string, hits: readonly Issue[], more: boolean, rejected: boolean): string {
  const form = `<form method="get" action="/ui/search"><label>Search <input name="q" value="${escape(query)}"></label> <button type="submit">Search</button></form>`;
  const note = query.trim() === '' ? '<p class="quiet-note">Type an issue id or words from the text.</p>'
    : rejected ? '<p class="quiet-note">That search is too long or contains a null character.</p>'
    : hits.length === 0 ? '<p class="quiet-note">Nothing matches.</p>'
    : '';
  const extra = more ? '<p class="section-note">More issues are not shown.</p>' : '';
  const list = hits.length === 0 ? '' : `<ul class="quiet-list">${hits.map(searchItem).join('')}</ul>`;
  return document('Search', `<h1>Search</h1>
${form}
${note}
${list}
${extra}`);
}

async function directHit(db: SqlExecutor, id: string, actor: Actor): Promise<Issue | null> {
  try {
    const result = await executeOperation(db, { op: 'show', id }, actor);
    return 'comments' in result ? result.issue : null;
  } catch (error) {
    if (error instanceof PolylinedbError && error.code === 'not_found') return null;
    throw error;
  }
}

async function searchHits(db: SqlExecutor, query: string, actor: Actor): Promise<{ hits: Issue[]; more: boolean; rejected: boolean }> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return { hits: [], more: false, rejected: false };
  let id: string | null = null;
  try { id = parseIssueId(trimmed); } catch { id = null; }
  const lookup = id === null ? Promise.resolve(null) : directHit(db, id, actor);
  if (trimmed.includes('\u0000') || new TextEncoder().encode(trimmed).length > 65536) {
    const direct = await lookup;
    return { hits: direct === null ? [] : [direct], more: false, rejected: direct === null };
  }
  const [direct, result] = await Promise.all([lookup, executeOperation(db, { op: 'search', query: trimmed, limit: 50 }, actor)]);
  if (!('issues' in result) || !('next_cursor' in result)) throw new PolylinedbError('storage_error', 'Search is unavailable', 500);
  const rest = result.issues.filter(issue => issue.id !== direct?.id);
  return { hits: direct === null ? rest : [direct, ...rest], more: result.next_cursor !== null, rejected: false };
}

function workingItem(row: ActiveClaimIssue, labels: ReadonlyMap<string, string>): string {
  const at = new Date(row.expiresAt * 1000).toISOString();
  const agent = row.agentLabel === null ? '' : `<span class="secondary">${escape(row.agentLabel)}</span>\n`;
  return `<li class="quiet-row"><a href="${escape(issueHref(row.issue.id))}">
<span class="primary">${escape(title(row.issue.body))}</span>
<span class="secondary">${escape(row.issue.project)}</span>
${agent}<span class="secondary">${escape(labels.get(row.actor) ?? row.actor)}</span>
<span class="secondary"><time datetime="${escape(at)}">${escape(japanTime(at))}</time></span>
</a></li>`;
}

function blockedItem(row: BlockedIssue): string {
  return `<li class="quiet-row"><a href="${escape(issueHref(row.issue.id))}">
<span class="primary">${escape(title(row.issue.body))}</span>
<span class="secondary">${escape(row.issue.status)}</span>
<span class="secondary">${escape(row.issue.project)}</span>
<span class="secondary">blocked ${row.openBlockers}</span>
</a></li>`;
}

function recentPage(issues: readonly Issue[], labels: ReadonlyMap<string, string>): string {
  const body = issues.length === 0 ? '<p class="quiet-note">Nothing has been updated.</p>' : `<ul class="quiet-list">${issues.map(issue => `<li class="quiet-row"><a href="${escape(issueHref(issue.id))}">
<span class="primary">${escape(title(issue.body))}</span>
<span class="secondary">${escape(issue.id)}</span>
<span class="secondary">${escape(issue.status)}</span>
<span class="secondary">${escape(issue.project)}</span>
<span class="secondary">Last updated <time datetime="${escape(issue.updated_at)}">${escape(japanTime(issue.updated_at))}</time></span>
<span class="secondary">${escape(labels.get(issue.updated_by) ?? issue.updated_by)}</span>
</a></li>`).join('')}</ul>`;
  return document('Recent updates', `<h1>Recent updates</h1>
<p class="section-note">Newest last update first, open and closed. This is not a close time.</p>
${body}`);
}

function blockedPage(rows: readonly BlockedIssue[]): string {
  const body = rows.length === 0 ? '<p class="quiet-note">Nothing is blocked.</p>' : `<ul class="quiet-list">${rows.map(blockedItem).join('')}</ul>`;
  return document('Blocked', `<h1>Blocked</h1>
<p class="section-note">Unfinished issues with a blocker that is not closed. Deferred blockers still count.</p>
${body}`);
}

function workingPage(rows: readonly ActiveClaimIssue[], labels: ReadonlyMap<string, string>): string {
  const body = rows.length === 0 ? '<p class="quiet-note">Nobody has an active claim.</p>' : `<ul class="quiet-list">${rows.map(row => workingItem(row, labels)).join('')}</ul>`;
  return document('Working now', `<h1>Working now</h1>
<p class="section-note">Active claims only. The time is when the claim expires.</p>
${body}`);
}

function inboxPage(issues: readonly Issue[], more: boolean): string {
  const note = more ? '<p class="section-note">More issues are not shown.</p>' : '';
  const body = issues.length === 0 ? '<p class="quiet-note">Nothing is waiting for you.</p>' : `<ul class="quiet-list">${issues.map(inboxItem).join('')}</ul>`;
  return document('Inbox', `<h1>Inbox</h1>
<p class="section-note">Open issues labeled owner-decision, owner-action, or main-wait.</p>
${body}
${note}`);
}

function filterHref(tool: string, project: string, status?: Status, label?: string): string {
  const params = new URLSearchParams();
  if (status !== undefined) params.set('status', status);
  if (label !== undefined) params.set('label', label);
  const query = params.toString();
  return `${projectHref(tool, project)}${query === '' ? '' : `?${query}`}`;
}

function chip(href: string, label: string, current: boolean): string {
  return `<a href="${escape(href)}"${current ? ' aria-current="page"' : ''}>${escape(label)}</a>`;
}

function projectPage(tool: string, project: string, issues: readonly ProjectIssue[], closed: readonly Issue[], labels: ReadonlyMap<string, string>, more: boolean, filter: { status?: Status; label?: string }): string {
  const note = more ? '<p class="section-note">More issues are not shown.</p>' : '';
  const filtered = filter.status !== undefined || filter.label !== undefined;
  const empty = filtered ? 'Nothing matches.' : 'Nothing is open.';
  const body = issues.length === 0 ? `<p class="quiet-note">${empty}</p>` : `<ul class="quiet-list">${issues.map(row => projectIssueItem(row, labels)).join('')}</ul>`;
  const statuses = ['open', 'in_progress', 'deferred', 'closed'] as const;
  const statusChips = [chip(filterHref(tool, project, undefined, filter.label), 'Unfinished', filter.status === undefined), ...statuses.map(status => chip(filterHref(tool, project, status, filter.label), status, filter.status === status))].join('');
  const labelChips = [chip(filterHref(tool, project, filter.status), 'Any label', filter.label === undefined), ...attentionLabels.map(label => chip(filterHref(tool, project, filter.status, label), label, filter.label === label))].join('');
  return document(tool, `<h1>${escape(tool)}</h1>
<p class="section-note">${escape(project)}</p>
<nav class="chips" aria-label="Status">${statusChips}</nav>
<nav class="chips" aria-label="Labels">${labelChips}</nav>
${body}
${note}
${section('Recently closed', closed, labels, 'Nothing has closed yet.', 'Ordered by last update. The close time is not recorded.')}`);
}

const htmlHeaders = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'private, no-cache',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; script-src 'sha256-wN5fn7M/0mts3B5WgddVicrWGcNvCBQK0rFn0GgjQx8='; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
const { 'content-type': _, ...revalidationHeaders } = htmlHeaders;

async function issueBlockers(db: SqlExecutor, id: string, actor: Actor): Promise<{ id: string; status: Status }[]> {
  const blockers: { id: string; status: Status }[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (;;) {
    const result = await executeOperation(db, { op: 'dependency_list', dependent_id: id, limit: 100, ...(after === undefined ? {} : { after }) }, actor);
    if (!('blockers' in result)) throw new PolylinedbError('storage_error', 'Blockers are unavailable', 500);
    blockers.push(...result.blockers);
    if (result.next_cursor === null) return blockers;
    if (seen.has(result.next_cursor)) throw new PolylinedbError('storage_error', 'Blocker page repeated', 500);
    seen.add(result.next_cursor);
    after = result.next_cursor;
  }
}

async function pageHtml(db: SqlExecutor, labels: ReadonlyMap<string, string>, route: UiRoute, actor: Actor): Promise<string | null> {
  if (route.page === 'issue') {
    try {
      const [result, blockers, parent, children] = await Promise.all([
        executeOperation(db, { op: 'show', id: route.id }, actor),
        issueBlockers(db, route.id, actor),
        issueParent(db, route.id),
        issueChildren(db, route.id, childLimit),
      ]);
      if (!('comments' in result)) throw new PolylinedbError('storage_error', 'Issue detail is unavailable', 500);
      return detailPage(result.issue, result.comments, claimDisplay(result.claim), blockers, parent, children.slice(0, shownChildren), children.length > shownChildren, labels);
    } catch (error) {
      if (error instanceof PolylinedbError && error.code === 'not_found') return null;
      throw error;
    }
  }
  if (route.page === 'recent') {
    const issues = await recentUpdates(db, listLimit);
    return recentPage(issues, labels);
  }
  if (route.page === 'blocked') {
    const rows = await blockedIssues(db, listLimit);
    return blockedPage(rows);
  }
  if (route.page === 'working') {
    const rows = await activeClaimIssues(db, listLimit);
    return workingPage(rows, labels);
  }
  if (route.page === 'search') {
    const found = await searchHits(db, route.query, actor);
    return searchPage(route.query, found.hits, found.more, found.rejected);
  }
  if (route.page === 'inbox') {
    const issues = await ownerInboxIssues(db, listLimit + 1);
    return inboxPage(issues.slice(0, listLimit), issues.length > listLimit);
  }
  if (route.page === 'project') {
    const [issues, closed] = await Promise.all([
      projectIssues(db, route.tool, route.project, projectIssueLimit, route.status ?? null, route.label ?? null),
      projectClosedIssues(db, route.tool, route.project, listLimit),
    ]);
    return projectPage(route.tool, route.project, issues.slice(0, shownProjectIssues), closed, labels, issues.length > shownProjectIssues, { status: route.status, label: route.label });
  }
  const [projects, awaitingMain] = await Promise.all([
    projectSummaries(db, projectSummaryLimit), issuesAwaitingMain(db, listLimit),
  ]);
  return uiPage({ projects: projects.slice(0, shownProjects), moreProjects: projects.length > shownProjects, awaitingMain }, labels);
}

async function entityTag(html: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html)));
  return `"${[...digest.slice(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('')}"`;
}

// If-None-Match uses the weak comparison, and a compressing proxy may weaken a strong tag on the way to the browser.
function revalidates(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch.split(',').some(tag => tag.trim().replace(/^W\//, '') === etag);
}

export async function uiResponse(db: SqlExecutor, labels: ReadonlyMap<string, string>, route: UiRoute, actor: Actor, ifNoneMatch: string | null): Promise<Response> {
  const html = await pageHtml(db, labels, route, actor);
  if (html === null) return uiNotFoundResponse();
  const etag = await entityTag(html);
  if (revalidates(ifNoneMatch, etag)) return new Response(null, { status: 304, headers: { ...revalidationHeaders, etag } });
  return new Response(html, { headers: { ...htmlHeaders, etag } });
}

const styles = `
@media (prefers-reduced-motion: no-preference) {
  @view-transition { navigation: auto; }
  ::view-transition-group(root),
  ::view-transition-image-pair(root),
  ::view-transition-old(root),
  ::view-transition-new(root) { animation-duration: 80ms; }
}
:root {
  color-scheme: light;
  --ink: #393730;
  --paper: #f5f1e8;
  --muted: #716b60;
  --line: #ddd7cb;
  --chip: #cfc6b8;
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
  color: var(--ink);
  background: var(--paper);
  font-synthesis: none;
  -webkit-font-smoothing: antialiased;
  -webkit-text-size-adjust: 100%;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='paper'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.75' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' opacity='.035' filter='url(%23paper)'/%3E%3C/svg%3E");
}
.paper {
  width: min(100%, 560px);
  margin: 0 auto;
  padding: clamp(48px, 8svh, 80px) max(32px, env(safe-area-inset-right)) max(32px, env(safe-area-inset-bottom)) max(32px, env(safe-area-inset-left));
}
h1 {
  margin: 0 0 24px;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(38px, 10vw, 48px);
  line-height: 1.4;
  letter-spacing: -.025em;
  font-weight: 500;
}
.quiet-section + .quiet-section { margin-top: 40px; }
.quiet-section h2 {
  margin: 0 0 4px;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 22px;
  font-weight: 500;
  line-height: 1.4;
}
.section-note, .quiet-note { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.5; overflow-wrap: anywhere; }
.quiet-note { margin-top: 18px; font-size: 18px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 0; }
.chips a { border: 1px solid var(--chip); border-radius: 999px; padding: 4px 10px; color: inherit; text-decoration: none; font-size: 14px; line-height: 1.4; }
.chips a[aria-current="page"] { background: var(--ink); color: var(--paper); }
.views { display: flex; flex-wrap: wrap; gap: 8px 16px; margin: 0 0 28px; }
.views a { color: inherit; font-size: 15px; line-height: 1.4; }
.quiet-list { list-style: none; margin: 0; padding: 0; }
.quiet-row { display: block; padding: 18px 0 20px; }
.quiet-row + .quiet-row { border-top: 1px solid var(--line); }
.quiet-row .primary { display: block; font-size: 19px; line-height: 1.45; overflow-wrap: anywhere; }
.quiet-row .secondary { display: block; margin-top: 4px; color: var(--muted); font-size: 15px; line-height: 1.5; overflow-wrap: anywhere; }
.quiet-row:has(> a) { padding: 0; }
.quiet-row > a { display: block; padding: 18px 0 20px; color: inherit; text-decoration: none; }
.quiet-row a .primary { text-decoration: underline; text-underline-offset: 0.18em; }
a { color: inherit; }
.prose { white-space: pre-wrap; overflow-wrap: anywhere; margin: 18px 0 0; font-size: 18px; line-height: 1.5; }
@media (max-width: 420px) {
  .paper { padding-top: 32px; }
  .views { gap: 6px 12px; margin-bottom: 20px; }
  h1 { margin-bottom: 16px; }
}
@media (max-width: 340px) {
  .paper { padding-right: max(24px, env(safe-area-inset-right)); padding-left: max(24px, env(safe-area-inset-left)); }
}
@media (min-width: 900px) {
  .paper { width: min(100%, 720px); }
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --ink: #f3ece3;
    --paper: #1c1916;
    --muted: #c8bfb2;
    --line: #3d362e;
    --chip: #5c5348;
  }
}
`;
