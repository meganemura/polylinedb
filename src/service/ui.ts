/** Renders the /ui pages for phones. GET stays free of side effects. The issue page posts Dispatch; other writes go through the operation endpoints. */
import { activeClaimIssues, startedWithoutClaim, activityAfter, activityNewest, attentionIssues, blockedIssues, blockerIsActive, claimDisplay, executeOperation, issueChildren, issueParent, ownerWaitLabels, parseIssueId, projectClosedIssues, projectIssues, projectSummaries, readyLabel, recentUpdates, PolylinedbError, type ActiveClaimIssue, type ActivityEvent, type ActivityPage, type Actor, type Attention, type AttentionIssue, type BlockedIssue, type ClaimDisplay, type Comment, type Issue, type IssueLink, type OpenIssue, type OwnerGroup, type OwnerLabel, type OwnerQueue, type ProjectIssue, type ProjectSummary, type Status } from '../records/index.ts';
import type { SqlExecutor } from '../records/persistence.ts';
import type { DispatchControl, DispatchOutcome } from './dispatch.ts';

type Viewer = { actor: Actor; dispatch: DispatchControl };

const listLimit = 50;
const projectSummaryLimit = 201;
const shownProjects = 200;
const projectIssueLimit = 101;
const shownProjectIssues = 100;
const childLimit = 101;
const shownChildren = 100;
const attentionLabels = ['ready', 'ready-for-land-queue', 'main-wait', 'main-lock', 'owner-decision', 'owner-action'] as const;

export type ActivityCursor = { since: number; incarnation: string };
export type UiRoute = { page: 'home' } | { page: 'inbox' } | { page: 'search'; query: string } | { page: 'working' } | { page: 'blocked' } | { page: 'recent' } | { page: 'activity'; after?: ActivityCursor | 'invalid' } | { page: 'project'; tool: string; project: string; status?: Status; label?: string } | { page: 'issue'; id: string };
const viewLinks: readonly (readonly [string, string])[] = [['/ui', 'Projects'], ['/ui/inbox', 'Inbox'], ['/ui/working', 'Working'], ['/ui/blocked', 'Blocked'], ['/ui/recent', 'Recent'], ['/ui/activity', 'Activity'], ['/ui/search', 'Search']];
const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Fixed prefetch hint. It is not application code: the page policy allows this text by hash and no other script.
const speculationRules = '{"prefetch":[{"source":"document","where":{"or":[{"href_matches":"/ui"},{"href_matches":"/ui/*"}]},"eagerness":"moderate","referrer_policy":"no-referrer"}]}';
// A polyline on the page paper, in the page colors and their night variants. It is a data: URI, so it needs no
// request, and the existing img-src data: allows it.
const faviconSvg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>"
  + '<style>rect{fill:#f5f1e8;stroke:#cfc6b8}path{stroke:#9a3412}circle{fill:#393730}'
  + '@media (prefers-color-scheme:dark){rect{fill:#1c1916;stroke:#5c5348}path{stroke:#f0a07a}circle{fill:#f3ece3}}</style>'
  + "<rect x='1' y='1' width='30' height='30' rx='7' stroke-width='2'/>"
  + "<path d='M7 22 13 11 19 18 25 9' fill='none' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/>"
  + "<circle cx='7' cy='22' r='2.5'/><circle cx='13' cy='11' r='2.5'/><circle cx='19' cy='18' r='2.5'/><circle cx='25' cy='9' r='2.5'/>"
  + '</svg>';
const faviconHref = `data:image/svg+xml,${faviconSvg.replace(/[%#<>"\s]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)}`;

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => escapes[character] ?? character);
}

// Some owner issues open with a marker line such as 要対応（owner-action）; the request itself is on the next line.
const ownerMarker = /^#*\s*(?:要対応|判断待ち)[（(][^（()）]*[）)]。?$/;

// Picks the title line, skipping one leading owner marker when another non-empty line follows it.
function titleLines(body: string): { lines: string[]; title: number; marker: number } {
  const lines = body.split('\n');
  const filled = lines.flatMap((line, index) => line.trim() ? [index] : []);
  const first = filled[0] ?? -1;
  const next = filled[1];
  if (first >= 0 && next !== undefined && ownerMarker.test(lines[first]!.trim())) return { lines, title: next, marker: first };
  return { lines, title: first, marker: -1 };
}

export function title(body: string): string {
  const { lines, title: index } = titleLines(body);
  const line = index < 0 ? '' : lines[index]!.trim();
  return line.replace(/^#+\s*/, '') || line;
}

// Workers run in UTC and Japan has no daylight saving time, so a fixed offset avoids output that differs with the runtime's ICU data.
function japanTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return `${new Date(time + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')} JST`;
}

function shownTime(issue: Issue, when: 'update' | 'closure'): { label: 'Last updated' | 'Closed'; at: string; by: string } {
  if (when === 'closure' && issue.closed_at != null && issue.closed_by != null) return { label: 'Closed', at: issue.closed_at, by: issue.closed_by };
  return { label: 'Last updated', at: issue.updated_at, by: issue.updated_by };
}

function row(issue: Issue, labels: ReadonlyMap<string, string>, when: 'update' | 'closure' = 'update'): string {
  const stamp = shownTime(issue, when);
  return `<li class="quiet-row"><a href="${escape(issueHref(issue.id))}">
<span class="primary">${escape(title(issue.body))}</span>
<span class="secondary">${escape(issue.id)} · ${stamp.label} <time datetime="${escape(stamp.at)}">${escape(japanTime(stamp.at))}</time></span>
<span class="secondary">${escape(person(stamp.by, labels))}</span>
</a></li>`;
}

function section(heading: string, issues: readonly Issue[], labels: ReadonlyMap<string, string>, empty: string, note?: string, when: 'update' | 'closure' = 'update'): string {
  const notice = note === undefined ? '' : `<p class="section-note">${note}</p>`;
  const body = issues.length === 0 ? `<p class="quiet-note">${empty}</p>` : `<ul class="quiet-list">${issues.map(issue => row(issue, labels, when)).join('')}</ul>`;
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
<span class="secondary">Updated <time datetime="${escape(summary.lastUpdatedAt)}">${escape(japanTime(summary.lastUpdatedAt))}</time></span>
<span class="secondary">open ${counts.open} · in_progress ${counts.in_progress} · deferred ${counts.deferred} · closed ${counts.closed}</span>
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

// The issue page keeps a skipped owner marker as the first body line, so the reader still sees it is an owner item.
export function bodyAfterTitle(body: string): string {
  const { lines, title: index, marker } = titleLines(body);
  if (index < 0) return '';
  const rest = lines.slice(index + 1);
  return (marker < 0 ? rest : [lines[marker]!.trim(), ...rest]).join('\n');
}

function commentItem(comment: Comment, labels: ReadonlyMap<string, string>): string {
  return `<li class="quiet-row">
<span class="secondary"><time datetime="${escape(comment.created_at)}">${escape(japanTime(comment.created_at))}</time></span>
<span class="secondary">${escape(labels.get(comment.created_by) ?? comment.created_by)}</span>${typeof comment.updated_at === 'string'
    ? `\n<span class="secondary">edited <time datetime="${escape(comment.updated_at)}">${escape(japanTime(comment.updated_at))}</time></span>` : ''}
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

// One line on whether the ready worklist would offer the issue to an agent now. It informs only; the dispatcher decides.
function startSummary(issue: Issue, activeBlockers: number, claim: ClaimDisplay, labels: ReadonlyMap<string, string>): string {
  const ownerWait = ownerWaitLabels.some(label => issue.labels.includes(label));
  const ready = issue.labels.includes(readyLabel);
  const locked = issue.labels.includes('main-lock');
  const claimed = claim.state === 'active';
  const parts = [
    ...(ownerWait ? ['owner wait, not agent work'] : []),
    ...(issue.status === 'open' ? [] : [issue.status]),
    ready ? 'ready' : 'not ready',
    ...(locked ? ['main-lock'] : []),
    activeBlockers === 0 ? 'no blockers' : `blocked ${activeBlockers}`,
    claimed ? `claimed by ${claim.agentLabel ?? person(claim.actor, labels)} until ${japanTimeFromSeconds(claim.expiresAt)}` : 'not claimed',
  ];
  const startable = ready && issue.status === 'open' && !locked && !ownerWait && activeBlockers === 0 && !claimed;
  return [...parts, startable ? 'can start now' : 'will not start now'].join(' · ');
}

// Sends Dispatch without leaving the page and shows the result beside the button. Without script, the form posts as before.
// The page policy allows this text by hash, so any change to it needs the new hash in htmlHeaders.
export const dispatchScript = `(() => {
  const form = document.querySelector('form.dispatch');
  const button = form && form.querySelector('button');
  const notes = form && form.querySelector('textarea');
  const result = form && form.querySelector('output');
  if (!form || !button || !notes || !result || !window.fetch || !window.DOMParser) return;
  const show = (text, state) => { result.textContent = text; result.dataset.state = state; };
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled) return;
    const body = new URLSearchParams(new FormData(form));
    button.disabled = true;
    button.textContent = 'Sending…';
    show('', 'sending');
    try {
      const response = await fetch(form.action, { method: 'POST', body, credentials: 'same-origin', redirect: 'manual' });
      if (response.type === 'opaqueredirect' || response.status === 0) {
        show('Your sign-in has expired. Reload the page, then press Dispatch again. Your notes are kept.', 'error');
        return;
      }
      const sentences = new DOMParser().parseFromString(await response.text(), 'text/html').querySelectorAll('main p');
      const sentence = sentences.length > 0 ? sentences[sentences.length - 1].textContent.trim() : '';
      if (response.ok) {
        const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        show((sentence || 'Sent.') + ' ' + at, 'ok');
        notes.value = '';
      } else {
        show((sentence || 'Dispatch failed (' + response.status + ').') + ' Your notes are kept.', 'error');
      }
    } catch {
      show('Could not reach the server. Your notes are kept.', 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Dispatch';
    }
  });
})();`;

const dispatchPlaceholder = 'What should the agent do or watch for?';

function dispatchForm(issue: Issue, activeBlockers: number, claim: ClaimDisplay, labels: ReadonlyMap<string, string>, control: DispatchControl): string {
  if (control === 'hidden') return '';
  const action = `/ui/i/${escape(issue.id)}/dispatch`;
  const button = control === 'unavailable'
    ? '<button type="submit" disabled>Dispatch</button><p class="quiet-note">Dispatch is not set up.</p>'
    : '<button type="submit">Dispatch</button>';
  return `<form method="post" action="${action}" class="dispatch">
<label for="dispatch-notes">Notes for the agent (optional)</label>
<textarea id="dispatch-notes" name="notes" maxlength="4096" rows="4" placeholder="${dispatchPlaceholder}"></textarea>
<div class="dispatch-action">${button}<p class="secondary">${escape(startSummary(issue, activeBlockers, claim, labels))}</p></div>${control === 'ready' ? '\n<output class="dispatch-result" role="status" aria-live="polite"></output>' : ''}</form>${control === 'ready' ? `\n<script>${dispatchScript}</script>` : ''}`;
}

function detailPage(issue: Issue, comments: readonly Comment[], claim: ClaimDisplay, blockers: readonly { id: string; status: Status }[], landsAfter: readonly { id: string; status: Status }[], parent: IssueLink | null, children: readonly IssueLink[], moreChildren: boolean, labels: ReadonlyMap<string, string>, dispatch: DispatchControl): string {
  const labelLine = issue.labels.length === 0 ? '<span class="secondary">No labels.</span>' : `<span class="secondary">${issue.labels.map(label => escape(label)).join(' ')}</span>`;
  const commentList = comments.length === 0 ? '<p class="quiet-note">No comments.</p>' : `<ul class="quiet-list">${comments.map(comment => commentItem(comment, labels)).join('')}</ul>`;
  const open = blockers.filter(blocker => blockerIsActive(blocker.status));
  const closed = blockers.filter(blocker => !blockerIsActive(blocker.status));
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
${dispatchForm(issue, open.length, claim, labels, dispatch)}
${parentLine(parent)}
${childrenSection(children, moreChildren)}
<div class="prose">${escape(bodyAfterTitle(issue.body))}</div>
<section class="quiet-section"><h2>Comments</h2>${commentList}</section>
${blockerSection('Active blockers', open, 'No active blockers.')}
${blockerSection('Closed blockers', closed, 'No closed blockers.')}${landsAfter.length === 0 ? '' : `
${blockerSection('Lands after', landsAfter, '')}`}`);
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
<link rel="icon" type="image/svg+xml" href="${faviconHref}">
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

const ownerHeadings: Record<OwnerLabel, string> = { 'owner-decision': 'To decide', 'owner-action': 'To do' };

/** "a", "a or b", "a, b, or c". */
function phrase(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  if (words.length === 2) return `${words[0]} or ${words[1]}`;
  const last = words[words.length - 1] ?? '';
  return `${words.slice(0, -1).join(', ')}, or ${last}`;
}

/** Coarse buckets keep the HTML, and so the ETag, unchanged between boundaries. */
function waitedFor(seconds: number): string {
  if (seconds < 3600) return 'under an hour';
  if (seconds < 86400) {
    const hours = Math.floor(seconds / 3600);
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  const days = Math.floor(seconds / 86400);
  return days === 1 ? '1 day' : `${days} days`;
}

function ownerRow(issue: OpenIssue, waitingSeconds: number | null): string {
  const waited = waitingSeconds === null ? '' : ` · <time datetime="${escape(issue.created_at)}">waiting ${waitedFor(waitingSeconds)}</time>`;
  return `<li class="quiet-row"><a href="${escape(issueHref(issue.id))}">
<span class="primary">${escape(title(issue.body))}</span>
<span class="secondary">${escape(issue.id)} · ${escape(issue.project)}${waited}</span>
</a></li>`;
}

function ownerGroup(group: OwnerGroup, waiting: ReadonlyMap<string, number | null>): string {
  if (group.issues.length === 0) return '';
  return `<h3>${ownerHeadings[group.label]}</h3><ul class="quiet-list">${group.issues.map(issue => ownerRow(issue, waiting.get(issue.id) ?? null)).join('')}</ul>`;
}

function ownerSection(queue: OwnerQueue, rows: readonly AttentionIssue[], more: boolean): string {
  const waiting = new Map(rows.map(row => [row.issue.id, row.waitingSeconds]));
  const total = queue.groups.reduce((sum, group) => sum + group.issues.length, 0);
  const count = more ? `${total}+` : String(total);
  const tally = `<p class="tally"><span class="count">${count}</span> ${total === 1 ? 'issue' : 'issues'} · `
    + queue.groups.map(group => `${group.issues.length} ${ownerHeadings[group.label].toLowerCase()}`).join(' · ') + '</p>';
  const body = total === 0 ? '<p class="quiet-note">Nothing is waiting on you.</p>' : tally + queue.groups.map(group => ownerGroup(group, waiting)).join('');
  const overflow = more ? '<p class="section-note">More issues are not shown.</p>' : '';
  const elsewhere = queue.notOpen === 0 ? ''
    : ` <a href="/ui/inbox">Inbox</a> also lists ${queue.notOpen} more ${queue.notOpen === 1 ? 'that is' : 'that are'} deferred or in progress.`;
  const note = `<p class="section-note">Open issues labeled ${escape(phrase(queue.groups.map(group => group.label)))}, across all projects. `
    + `Higher priority first, then the longest waiting. The time is how long since the issue was created.${elsewhere}</p>`;
  return `<section class="quiet-section"><h2>Waiting on you</h2>${body}${overflow}${note}</section>`;
}

export function uiPage(lists: { projects: readonly ProjectSummary[]; moreProjects: boolean; attention: Attention }, labels: ReadonlyMap<string, string>): string {
  return document('Projects', `<h1>Projects</h1>
${ownerSection(lists.attention.waitingOnOwner, lists.attention.issues, lists.attention.more)}
${projectsSection(lists.projects, lists.moreProjects)}
${section('Waiting for main', lists.attention.waitingForMain.slice(0, listLimit), labels, 'Nothing is waiting for main.', 'Open issues with the main-wait label.')}`);
}

function inboxItem(row: AttentionIssue): string {
  const issue = row.issue;
  return `<li class="quiet-row"><a href="${escape(issueHref(issue.id))}">
<span class="primary">${escape(title(issue.body))}</span>
<span class="secondary">${escape(issue.id)}</span>
<span class="secondary">${escape(issue.status)}</span>
<span class="secondary">${escape(issue.tool)}</span>
<span class="secondary">${escape(issue.project)}</span>
<span class="secondary">${row.labels.map(label => escape(label)).join(' ')}</span>
<span class="secondary">Last updated <time datetime="${escape(issue.updated_at)}">${escape(japanTime(issue.updated_at))}</time></span>
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
<span class="secondary">${escape(row.issue.id)} · ${escape(row.issue.project)}</span>
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

const eventWords: Record<string, string> = {
  created: 'Created', updated: 'Updated', status_changed: 'Status changed', commented: 'Commented', claim_acquired: 'Claimed',
  claim_released: 'Released', dependency_added: 'Blocker added', dependency_removed: 'Blocker removed', became_ready: 'Became ready',
};

function activityItem(event: ActivityEvent, labels: ReadonlyMap<string, string>): string {
  const at = new Date(event.occurred_at * 1000).toISOString();
  const words = event.relation === 'lands_after' ? (event.kind === 'dependency_added' ? 'Land order added' : 'Land order removed')
    : event.kind === 'updated' && event.fields.length > 0 ? `Updated ${event.fields.join(', ')}` : eventWords[event.kind] ?? event.kind;
  return `<li class="quiet-row"><a href="${escape(issueHref(event.issue_id))}">
<span class="primary">${escape(title(event.body))}</span>
<span class="secondary">${escape(words)} · ${escape(event.issue_id)}</span>
<span class="secondary">${escape(event.project)}</span>
<span class="secondary">${escape(person(event.actor, labels))}</span>
<span class="secondary"><time datetime="${escape(at)}">${escape(japanTimeFromSeconds(event.occurred_at))}</time></span>
</a></li>`;
}

function activityHref(since: number, incarnation: string): string {
  return `/ui/activity?after=${since}&incarnation=${encodeURIComponent(incarnation)}`;
}

function activityPage(page: ActivityPage, labels: ReadonlyMap<string, string>, after: ActivityCursor | null): string {
  const list = page.events.length === 0
    ? `<p class="quiet-note">${after === null ? 'Nothing has happened yet.' : 'Nothing new since this link.'}</p>`
    : `<ul class="quiet-list">${page.events.map(event => activityItem(event, labels)).join('')}</ul>`;
  if (after === null) {
    const more = page.more ? '\n<p class="section-note">Older events are not shown.</p>' : '';
    return document('Activity', `<h1>Activity</h1>
<p class="section-note">Newest first, at most ${listLimit}. Comments and claims show here even when they do not change the last update.</p>
${list}${more}
<p class="section-note">Newest event ${page.latest}. <a href="${escape(activityHref(page.latest, page.incarnation))}">Keep this link</a> to see only what happens after now.</p>`);
  }
  const last = page.events.at(-1)?.seq ?? after.since;
  const next = page.more
    ? `<p class="section-note"><a href="${escape(activityHref(last, page.incarnation))}">Newer events</a></p>`
    : `<p class="section-note">Up to date. <a href="${escape(activityHref(last, page.incarnation))}">Keep this link</a> to see only what happens after now.</p>`;
  return document('Activity', `<h1>Activity since event ${after.since}</h1>
<p class="section-note">Oldest first, at most ${listLimit} per page.</p>
${list}
${next}`);
}

function activityProblemPage(sentence: string): string {
  return document('Activity', `<h1>Activity</h1>
<p class="quiet-note">${sentence} Start again from the latest activity.</p>
<p><a href="/ui/activity">Latest activity</a></p>`);
}

async function activityHtml(db: SqlExecutor, labels: ReadonlyMap<string, string>, after: ActivityCursor | 'invalid' | undefined): Promise<string> {
  if (after === undefined) return activityPage(await activityNewest(db, listLimit), labels, null);
  if (after === 'invalid') return activityProblemPage('This activity link is not valid.');
  try {
    return activityPage(await activityAfter(db, after.since, after.incarnation, listLimit), labels, after);
  } catch (error) {
    if (!(error instanceof PolylinedbError)) throw error;
    if (error.code === 'incarnation_mismatch') return activityProblemPage('This activity link is from another store.');
    if (error.code === 'cursor_expired') return activityProblemPage('Some events after this link were removed.');
    if (error.code === 'invalid_input') return activityProblemPage('This activity link is not valid.');
    throw error;
  }
}

function blockedPage(rows: readonly BlockedIssue[]): string {
  const body = rows.length === 0 ? '<p class="quiet-note">Nothing is blocked.</p>' : `<ul class="quiet-list">${rows.map(blockedItem).join('')}</ul>`;
  return document('Blocked', `<h1>Blocked</h1>
<p class="section-note">Unfinished issues with an active blocker. Deferred blockers still count.</p>
${body}`);
}

function workingPage(rows: readonly ActiveClaimIssue[], unclaimed: readonly Issue[], labels: ReadonlyMap<string, string>): string {
  const body = rows.length === 0 ? '<p class="quiet-note">Nobody has an active claim.</p>' : `<ul class="quiet-list">${rows.map(row => workingItem(row, labels)).join('')}</ul>`;
  const stale = unclaimed.length === 0 ? '<p class="quiet-note">Every started issue has an active claim.</p>' : `<ul class="quiet-list">${unclaimed.slice(0, listLimit).map(searchItem).join('')}</ul>`;
  const more = unclaimed.length > listLimit ? '<p class="section-note">More issues are not shown.</p>' : '';
  return document('Working now', `<h1>Working now</h1>
<p class="section-note">Active claims only. The time is when the claim expires.</p>
${body}
<h2>Started without an active claim</h2>
<p class="section-note">Issues in progress, other than epics, whose claim was released, expired, or never acquired.</p>
${stale}
${more}`);
}

function inboxPage(rows: readonly AttentionIssue[], more: boolean): string {
  const note = more ? '<p class="section-note">More issues are not shown.</p>' : '';
  const body = rows.length === 0 ? '<p class="quiet-note">Nothing is waiting for you.</p>' : `<ul class="quiet-list">${rows.map(inboxItem).join('')}</ul>`;
  return document('Inbox', `<h1>Inbox</h1>
<p class="section-note">Issues labeled owner-decision, owner-action, or main-wait, with status open, in_progress, or deferred.</p>
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
<div class="filters">
<section class="filter-rail filter-state">
<p class="filter-kicker"><span class="filter-name">State</span> One status at a time</p>
<nav class="segment" aria-label="State">${statusChips}</nav>
<p class="filter-note">Unfinished means every status except closed.</p>
</section>
<section class="filter-rail filter-mark">
<p class="filter-kicker"><span class="filter-name">Mark</span> A label, not a status</p>
<nav class="stamps" aria-label="Mark">${labelChips}</nav>
<p class="filter-note">A mark sits on the issue. It does not change the status.</p>
</section>
</div>
${body}
${note}
${section('Recently closed', closed, labels, 'Nothing has closed yet.', 'Ordered by close time. A row without a close record shows its last update, which is not the close time.', 'closure')}`);
}

const htmlHeaders = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'private, no-cache',
  'x-content-type-options': 'nosniff',
  // Under no-referrer, browsers send Origin: null on the same-origin Dispatch POST, and dispatch rejects that origin.
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'none'; script-src 'sha256-wN5fn7M/0mts3B5WgddVicrWGcNvCBQK0rFn0GgjQx8=' 'sha256-cGc6YcHTVBmc1w2BjXzpBFQVyud5Cto87clfawJ+ous='; connect-src 'self'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
const { 'content-type': _, ...revalidationHeaders } = htmlHeaders;

function dispatchSentence(outcome: Exclude<DispatchOutcome, { kind: 'not_found' }>): string {
  switch (outcome.kind) {
    case 'sent': return 'Sent.';
    case 'already_sent': return outcome.phase === 'in_flight' ? 'Already sending.' : 'Already sent.';
    case 'retried': return outcome.delivered ? 'Sent on retry.' : 'Not sent. Press Dispatch again to retry.';
    case 'not_sent': return 'Not sent. Press Dispatch again to retry.';
    case 'conflict': return 'This dispatch conflicts with the send already open for this issue.';
    case 'unavailable': return 'Dispatch is not set up.';
    case 'not_permitted': return 'Dispatch is not available for this actor.';
    case 'invalid_form': return 'Dispatch could not read that form.';
    default: { const unreachable: never = outcome; return unreachable; }
  }
}

function dispatchStatus(outcome: Exclude<DispatchOutcome, { kind: 'not_found' }>): number {
  switch (outcome.kind) {
    case 'sent':
    case 'already_sent': return 200;
    case 'retried': return outcome.delivered ? 200 : 502;
    case 'not_sent': return 502;
    case 'conflict': return 409;
    case 'unavailable': return 503;
    case 'not_permitted': return 403;
    case 'invalid_form': return 400;
    default: { const unreachable: never = outcome; return unreachable; }
  }
}

export function dispatchResponse(outcome: DispatchOutcome, issueId: string): Response {
  if (outcome.kind === 'not_found') return uiNotFoundResponse();
  const sentence = dispatchSentence(outcome);
  return new Response(document('Dispatch', `<p><a href="/ui/i/${escape(issueId)}">${escape(issueId)}</a></p>\n<p>${escape(sentence)}</p>`), {
    status: dispatchStatus(outcome), headers: htmlHeaders,
  });
}

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

async function pageHtml(db: SqlExecutor, labels: ReadonlyMap<string, string>, route: UiRoute, viewer: Viewer): Promise<string | null> {
  const actor = viewer.actor;
  if (route.page === 'issue') {
    try {
      const [result, blockers, landOrder, parent, children] = await Promise.all([
        executeOperation(db, { op: 'show', id: route.id }, actor),
        issueBlockers(db, route.id, actor),
        executeOperation(db, { op: 'land_order_list', issue_id: route.id }, actor),
        issueParent(db, route.id),
        issueChildren(db, route.id, childLimit),
      ]);
      if (!('comments' in result) || !('after' in landOrder)) throw new PolylinedbError('storage_error', 'Issue detail is unavailable', 500);
      return detailPage(result.issue, result.comments, claimDisplay(result.claim), blockers, landOrder.after, parent, children.slice(0, shownChildren), children.length > shownChildren, labels, viewer.dispatch);
    } catch (error) {
      if (error instanceof PolylinedbError && error.code === 'not_found') return null;
      throw error;
    }
  }
  if (route.page === 'recent') {
    const issues = await recentUpdates(db, listLimit);
    return recentPage(issues, labels);
  }
  if (route.page === 'activity') return activityHtml(db, labels, route.after);
  if (route.page === 'blocked') {
    const rows = await blockedIssues(db, listLimit);
    return blockedPage(rows);
  }
  if (route.page === 'working') {
    const [rows, unclaimed] = await Promise.all([activeClaimIssues(db, listLimit), startedWithoutClaim(db, listLimit + 1)]);
    return workingPage(rows, unclaimed, labels);
  }
  if (route.page === 'search') {
    const found = await searchHits(db, route.query, actor);
    return searchPage(route.query, found.hits, found.more, found.rejected);
  }
  if (route.page === 'inbox') {
    const { issues } = await attentionIssues(db);
    return inboxPage(issues.slice(0, listLimit), issues.length > listLimit);
  }
  if (route.page === 'project') {
    const [issues, closed] = await Promise.all([
      projectIssues(db, route.tool, route.project, projectIssueLimit, route.status ?? null, route.label ?? null),
      projectClosedIssues(db, route.tool, route.project, listLimit),
    ]);
    return projectPage(route.tool, route.project, issues.slice(0, shownProjectIssues), closed, labels, issues.length > shownProjectIssues, { status: route.status, label: route.label });
  }
  const [projects, waiting] = await Promise.all([projectSummaries(db, projectSummaryLimit), attentionIssues(db)]);
  return uiPage({ projects: projects.slice(0, shownProjects), moreProjects: projects.length > shownProjects, attention: waiting }, labels);
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

export async function uiResponse(db: SqlExecutor, labels: ReadonlyMap<string, string>, route: UiRoute, viewer: Viewer, ifNoneMatch: string | null): Promise<Response> {
  const html = await pageHtml(db, labels, route, viewer);
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
  --mark: #9a3412;
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
.tally { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.5; }
.tally .count { color: var(--ink); font-family: Georgia, "Times New Roman", serif; font-size: 22px; line-height: 1; }
.quiet-section h3 { margin: 20px 0 0; font-size: 12px; font-weight: 700; line-height: 1.3; letter-spacing: .16em; text-transform: uppercase; }
.section-note, .quiet-note { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.5; overflow-wrap: anywhere; }
.quiet-note { margin-top: 18px; font-size: 18px; }
.filters { display: grid; gap: 18px; margin: 28px 0 8px; }
.filter-rail { display: grid; gap: 8px; padding: 14px 0 16px; border-top: 1px solid var(--line); }
.filter-kicker { margin: 0; font-family: Georgia, "Times New Roman", serif; font-size: 15px; line-height: 1.3; letter-spacing: .01em; }
.filter-kicker .filter-name { display: block; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif; font-size: 12px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }
.filter-state .filter-name { color: var(--ink); }
.filter-mark .filter-name { color: var(--mark); }
.filter-note { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.45; }
.segment { display: flex; overflow-x: auto; border: 2px solid var(--ink); }
.segment a { flex: 1 0 auto; padding: 9px 10px; border-right: 1px solid var(--ink); color: inherit; text-align: center; text-decoration: none; font-size: 13px; line-height: 1.3; }
.segment a:last-child { border-right: 0; }
.segment a[aria-current="page"] { background: var(--ink); color: var(--paper); }
.stamps { display: flex; flex-wrap: wrap; gap: 8px; }
.stamps a { border: 1.5px solid var(--mark); padding: 6px 10px; color: var(--mark); text-decoration: none; font-size: 13px; line-height: 1.3; background:
  linear-gradient(var(--mark), var(--mark)) left / 4px 100% no-repeat; padding-left: 12px; }
.stamps a[aria-current="page"] { background: var(--mark); color: var(--paper); }
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
.dispatch { display: grid; gap: 10px; margin: 28px 0; padding: 18px 0 20px; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.dispatch label { font-size: 12px; font-weight: 700; line-height: 1.3; letter-spacing: .16em; text-transform: uppercase; color: var(--muted); }
.dispatch textarea { display: block; width: 100%; min-height: 7.5em; margin: 0; padding: 12px 14px; border: 1px solid var(--chip); border-radius: 10px; background: var(--paper); color: var(--ink); font: inherit; font-size: 16px; line-height: 1.5; resize: vertical; -webkit-appearance: none; appearance: none; }
.dispatch textarea::placeholder { color: var(--muted); opacity: .8; }
.dispatch textarea:focus { border-color: var(--ink); outline: none; }
.dispatch-action { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; }
.dispatch button { flex: 0 0 auto; min-width: 132px; min-height: 48px; margin: 0; padding: 12px 24px; border: 0; border-radius: 10px; background: var(--mark); color: var(--paper); font: inherit; font-size: 17px; font-weight: 600; line-height: 1.2; letter-spacing: .01em; cursor: pointer; -webkit-appearance: none; appearance: none; touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
.dispatch button:hover { filter: brightness(1.1); }
.dispatch button:active { filter: brightness(.92); }
.dispatch button:focus-visible, .dispatch textarea:focus-visible { outline: 2px solid var(--mark); outline-offset: 2px; }
.dispatch button:disabled { background: var(--chip); color: var(--muted); cursor: not-allowed; filter: none; }
.dispatch-action .secondary { flex: 1 1 14em; margin: 0; color: var(--muted); font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
.dispatch-result { display: block; font-size: 15px; line-height: 1.5; overflow-wrap: anywhere; }
.dispatch-result:empty { display: none; }
.dispatch-result[data-state="ok"] { color: var(--ink); }
.dispatch-result[data-state="error"] { color: var(--mark); font-weight: 600; }
.dispatch-action .quiet-note { flex-basis: 100%; order: 3; margin: 0; font-size: 14px; }
.prose { white-space: pre-wrap; overflow-wrap: anywhere; margin: 18px 0 0; font-size: 18px; line-height: 1.5; }
@media (max-width: 420px) {
  .paper { padding-top: 32px; }
  .dispatch button { flex-basis: 100%; }
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
    --mark: #f0a07a;
  }
}
`;
