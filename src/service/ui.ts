/** Renders the read-only /ui pages for phones. They have no form, script, or write path; changes go through the operation endpoints. */
import { executeOperation, issuesAwaitingMain, projectIssues, projectSummaries, recentlyClosedIssues, PolylinedbError, type Actor, type Comment, type Issue, type ProjectSummary } from '../records/index.ts';
import type { SqlExecutor } from '../records/persistence.ts';

const listLimit = 50;
const projectSummaryLimit = 201;
const shownProjects = 200;
const projectIssueLimit = 101;
const shownProjectIssues = 100;
const attentionLabels = ['ready', 'ready-for-land-queue', 'main-wait', 'main-lock', 'owner-decision', 'owner-action'] as const;

export type UiRoute = { page: 'home' } | { page: 'project'; tool: string; project: string } | { page: 'issue'; id: string };
const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

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
<span class="secondary">${escape(issue.id)} · 最終更新 <time datetime="${escape(issue.updated_at)}">${escape(japanTime(issue.updated_at))}</time></span>
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

function projectIssueItem(issue: Issue): string {
  return `<li class="quiet-row"><a href="${escape(issueHref(issue.id))}">
<span class="primary">${escape(title(issue.body))}</span>
<span class="secondary">${escape(issue.status)}</span>
<span class="secondary">priority ${issue.priority}</span>
<span class="secondary">${escape(issue.type)}</span>
${attention(issue.labels)}<span class="secondary">${escape(issue.id)}</span>
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

function detailPage(issue: Issue, comments: readonly Comment[], labels: ReadonlyMap<string, string>): string {
  const labelLine = issue.labels.length === 0 ? '<span class="secondary">No labels.</span>' : `<span class="secondary">${issue.labels.map(label => escape(label)).join(' ')}</span>`;
  const commentList = comments.length === 0 ? '<p class="quiet-note">No comments.</p>' : `<ul class="quiet-list">${comments.map(comment => commentItem(comment, labels)).join('')}</ul>`;
  return document(title(issue.body), `<p><a href="${escape(projectHref(issue.tool, issue.project))}">Project</a></p>
<h1>${escape(title(issue.body))}</h1>
<span class="secondary">${escape(issue.id)}</span>
<span class="secondary">${escape(issue.status)}</span>
<span class="secondary">${escape(issue.type)}</span>
<span class="secondary">priority ${issue.priority}</span>
<span class="secondary">${escape(issue.tool)}</span>
<span class="secondary">${escape(issue.project)}</span>
${labelLine}
<div class="prose">${escape(bodyAfterTitle(issue.body))}</div>
<section class="quiet-section"><h2>Comments</h2>${commentList}</section>`);
}

function notFoundPage(): string {
  return document('Not found', `<h1>Not found</h1>
<p class="quiet-note">Issue was not found.</p>`);
}

function document(pageTitle: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f5f1e8">
<meta name="robots" content="noindex">
<title>${escape(pageTitle)}</title>
<link rel="icon" href="data:,">
<style>${styles}</style>
</head>
<body>
<main class="paper">
${body}
</main>
</body>
</html>`;
}

export function uiPage(lists: { projects: readonly ProjectSummary[]; moreProjects: boolean; awaitingMain: readonly Issue[]; recentlyClosed: readonly Issue[] }, labels: ReadonlyMap<string, string>): string {
  return document('Recent work', `<h1>Recent work</h1>
${projectsSection(lists.projects, lists.moreProjects)}
${section('main 待ち', lists.awaitingMain, labels, 'Nothing waits for main.', 'Open issues labelled main-wait.')}
${section('Recently closed', lists.recentlyClosed, labels, 'Nothing has closed yet.', 'Ordered by 最終更新. pd does not record when an issue closed.')}`);
}

function projectPage(tool: string, project: string, issues: readonly Issue[], more: boolean): string {
  const note = more ? '<p class="section-note">More issues are not shown.</p>' : '';
  const body = issues.length === 0 ? '<p class="quiet-note">Nothing is open.</p>' : `<ul class="quiet-list">${issues.map(projectIssueItem).join('')}</ul>`;
  return document(tool, `<h1>${escape(tool)}</h1>
<p class="section-note">${escape(project)}</p>
${body}
${note}`);
}

const htmlHeaders = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export async function uiResponse(db: SqlExecutor, labels: ReadonlyMap<string, string>, route: UiRoute, actor: Actor): Promise<Response> {
  if (route.page === 'issue') {
    try {
      const result = await executeOperation(db, { op: 'show', id: route.id }, actor);
      if (!('comments' in result)) throw new PolylinedbError('storage_error', 'Issue detail is unavailable', 500);
      return new Response(detailPage(result.issue, result.comments, labels), { headers: htmlHeaders });
    } catch (error) {
      if (error instanceof PolylinedbError && error.code === 'not_found') return new Response(notFoundPage(), { status: 404, headers: htmlHeaders });
      throw error;
    }
  }
  if (route.page === 'project') {
    const issues = await projectIssues(db, route.tool, route.project, projectIssueLimit);
    return new Response(projectPage(route.tool, route.project, issues.slice(0, shownProjectIssues), issues.length > shownProjectIssues), { headers: htmlHeaders });
  }
  const [projects, awaitingMain, recentlyClosed] = await Promise.all([
    projectSummaries(db, projectSummaryLimit), issuesAwaitingMain(db, listLimit), recentlyClosedIssues(db, listLimit),
  ]);
  return new Response(uiPage({ projects: projects.slice(0, shownProjects), moreProjects: projects.length > shownProjects, awaitingMain, recentlyClosed }, labels), { headers: htmlHeaders });
}

const styles = `
:root {
  color-scheme: light;
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
  color: #393730;
  background: #f5f1e8;
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
.section-note, .quiet-note { margin: 0; color: #716b60; font-size: 15px; line-height: 1.5; overflow-wrap: anywhere; }
.quiet-note { margin-top: 18px; font-size: 18px; }
.quiet-list { list-style: none; margin: 0; padding: 0; }
.quiet-row { display: block; padding: 18px 0 20px; }
.quiet-row + .quiet-row { border-top: 1px solid #ddd7cb; }
.quiet-row .primary { display: block; font-size: 19px; line-height: 1.45; overflow-wrap: anywhere; }
.quiet-row .secondary { display: block; margin-top: 4px; color: #716b60; font-size: 15px; line-height: 1.5; overflow-wrap: anywhere; }
.quiet-row:has(> a) { padding: 0; }
.quiet-row > a { display: block; padding: 18px 0 20px; color: inherit; text-decoration: none; }
.quiet-row a .primary { text-decoration: underline; text-underline-offset: 0.18em; }
a { color: inherit; }
.prose { white-space: pre-wrap; overflow-wrap: anywhere; margin: 18px 0 0; font-size: 18px; line-height: 1.5; }
@media (max-width: 340px) {
  .paper { padding-right: max(24px, env(safe-area-inset-right)); padding-left: max(24px, env(safe-area-inset-left)); }
}
`;
