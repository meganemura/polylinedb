/**
 * The /ui entry: maps a route to its reads, renders the page, and adds the page headers (ETag, CSP by hash). GET never writes.
 * POST routes go to ui-writes.ts. Access, origin checks, and Server-Timing belong to the Worker entry.
 */
import { executeOperation, PolylinedbError, projectClosedIssues, projectIssues, projectSummaries, type Actor, type Issue, type Status } from '../records/index.ts';
import type { SqlExecutor } from '../records/persistence.ts';
import type { DispatchControl, DispatchOutcome } from './dispatch.ts';
import { pageScript, speculationRules } from './ui-assets.ts';
import { flash } from './ui-brief.ts';
import { messagePage, activityPage, agentsPage, issuePage, landingPage, newPage, projectPage, projectsPage, searchPage, stuckPage, tabCounts, todayPage,
  type ActivityCursor } from './ui-pages.ts';
import { readActivity, readIssueView, searchHits } from './ui-reads.ts';
import { composeLanes, readLanes } from './ui-today.ts';
import { doneParam, landedSentence, uiWrite, type WriteRoute } from './ui-writes.ts';
import type { Viewer, ViewerRole } from './ui-html.ts';

export { bodyAfterTitle, title } from './ui-html.ts';
export { pageScript, speculationRules } from './ui-assets.ts';
export { issueActions, returnPath, type IssueAction, type WriteRoute } from './ui-writes.ts';
export type { ActivityCursor } from './ui-pages.ts';

export type UiRoute = { page: 'today' } | { page: 'agents' } | { page: 'activity'; after?: ActivityCursor | 'invalid' } | { page: 'landing' } | { page: 'stuck' }
  | { page: 'projects' } | { page: 'project'; tool: string; project: string; status?: Status; label?: string } | { page: 'search'; query: string }
  | { page: 'new' } | { page: 'issue'; id: string };
/** Who reads the page: the caller from Access, its role, and what Dispatch would do for it. */
export type UiCaller = { actor: Actor; role: ViewerRole; dispatch: DispatchControl };

const projectSummaryLimit = 201;
const shownProjects = 200;
const projectIssueLimit = 101;
const shownProjectIssues = 100;
const closedLimit = 50;

const viewerOf = (caller: UiCaller, labels: ReadonlyMap<string, string>): Viewer => ({ ...caller, labels, now: Math.floor(Date.now() / 1000) });

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...digest));
}
// Workers forbid async work at module scope, so the policy is computed on the first request and kept.
let policy: Promise<string> | undefined;
/** The page policy: the speculation rules and the one fixed script, each allowed by its hash. No inline style attribute is written, but style-src stays 'unsafe-inline' for the one <style> block. */
export function contentSecurityPolicy(): Promise<string> {
  policy ??= Promise.all([sha256(speculationRules), sha256(pageScript)]).then(([rules, script]) =>
    `default-src 'none'; script-src 'sha256-${rules}' 'sha256-${script}'; connect-src 'self'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
  return policy;
}
async function htmlHeaders(): Promise<Record<string, string>> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'private, no-cache',
    'x-content-type-options': 'nosniff',
    // Under no-referrer, browsers send Origin: null on a same-origin form POST, and the write routes reject that origin.
    'referrer-policy': 'same-origin',
    'content-security-policy': await contentSecurityPolicy(),
  };
}

export async function uiNotFoundResponse(caller: UiCaller, labels: ReadonlyMap<string, string>): Promise<Response> {
  const viewer = viewerOf(caller, labels);
  return new Response(messagePage('Not found', 'This page does not exist. <a href="/ui">Go to Today</a>.', viewer, { today: 0, stuck: 0 }), { status: 404, headers: await htmlHeaders() });
}

async function doneIssue(db: SqlExecutor, id: string, actor: Actor): Promise<Issue | null> {
  try {
    const shown = await executeOperation(db, { op: 'show', id }, actor);
    return 'comments' in shown ? shown.issue : null;
  } catch (error) {
    if (error instanceof PolylinedbError && error.code === 'not_found') return null;
    throw error;
  }
}

/** Every page reads the lanes for its tab badges, in the same parallel wave as its own reads. */
async function pageHtml(db: SqlExecutor, route: UiRoute, viewer: Viewer, url: URL): Promise<string | null> {
  const actor = viewer.actor;
  const lanesRead = readLanes(db, actor);
  const done = doneParam(url.searchParams.get('done'));
  const doneRead = done === null ? Promise.resolve(null) : doneIssue(db, done.id, actor);
  switch (route.page) {
    case 'today': {
      const [reads, issue] = await Promise.all([lanesRead, doneRead]);
      return todayPage(composeLanes(reads), viewer, done === null ? null : { ...done, issue });
    }
    case 'agents': return agentsPage(composeLanes(await lanesRead), viewer);
    case 'stuck': return stuckPage(composeLanes(await lanesRead), viewer);
    case 'landing': return landingPage(composeLanes(await lanesRead), viewer, landedSentence(url.searchParams));
    case 'activity': {
      const [reads, page] = await Promise.all([lanesRead, readActivity(db, route.after)]);
      return activityPage(page, route.after === undefined || route.after === 'invalid' ? null : route.after, viewer, tabCounts(composeLanes(reads)));
    }
    case 'projects': {
      const [reads, projects] = await Promise.all([lanesRead, projectSummaries(db, projectSummaryLimit)]);
      return projectsPage(projects.slice(0, shownProjects), projects.length > shownProjects, reads.attention, viewer, tabCounts(composeLanes(reads)));
    }
    case 'project': {
      const [reads, issues, closed] = await Promise.all([lanesRead,
        projectIssues(db, route.tool, route.project, projectIssueLimit, route.status ?? null, route.label ?? null),
        projectClosedIssues(db, route.tool, route.project, closedLimit)]);
      return projectPage({ tool: route.tool, project: route.project, ...(route.status === undefined ? {} : { status: route.status }), ...(route.label === undefined ? {} : { label: route.label }),
        issues: issues.slice(0, shownProjectIssues), more: issues.length > shownProjectIssues, closed }, viewer, tabCounts(composeLanes(reads)));
    }
    case 'search': {
      const [reads, found] = await Promise.all([lanesRead, searchHits(db, route.query, actor)]);
      return searchPage(route.query, found.hits, found.more, found.rejected, viewer, tabCounts(composeLanes(reads)));
    }
    case 'new': {
      const [reads, projects] = await Promise.all([lanesRead, projectSummaries(db, shownProjects)]);
      const counts = tabCounts(composeLanes(reads));
      if (viewer.role === 'reader') return messagePage('New issue', 'Signed in as a reader. New issues wait on the owner.', viewer, counts);
      // The project page links here with ?project=<tool>\n<project>, the value of the project select.
      return newPage(projects, url.searchParams.get('project'), viewer, counts);
    }
    case 'issue': {
      const [reads, view, issue] = await Promise.all([lanesRead, readIssueView(db, route.id, actor), doneRead]);
      if (view === null) return null;
      const lanes = composeLanes(reads);
      const top = done !== null && done.id === route.id ? flash(done.kind, issue, done.id, lanes, viewer) : '';
      return issuePage(view, viewer, tabCounts(lanes), top);
    }
    default: { const unreachable: never = route; return unreachable; }
  }
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

export async function uiResponse(db: SqlExecutor, labels: ReadonlyMap<string, string>, route: UiRoute, caller: UiCaller, url: URL, ifNoneMatch: string | null): Promise<Response> {
  const viewer = viewerOf(caller, labels);
  const [html, headers] = await Promise.all([pageHtml(db, route, viewer, url), htmlHeaders()]);
  if (html === null) return uiNotFoundResponse(caller, labels);
  const etag = await entityTag(html);
  const { 'content-type': _, ...revalidation } = headers;
  if (revalidates(ifNoneMatch, etag)) return new Response(null, { status: 304, headers: { ...revalidation, etag } });
  return new Response(html, { headers: { ...headers, etag } });
}

/** Runs one /ui POST and turns its answer into a response: 303 to a /ui path, JSON for the fixed script, or a page. */
export async function uiWriteResponse(db: SqlExecutor, labels: ReadonlyMap<string, string>, route: WriteRoute, caller: UiCaller, form: URLSearchParams | 'invalid', json: boolean,
  dispatch: (id: string, form: URLSearchParams | 'invalid') => Promise<DispatchOutcome>): Promise<Response> {
  const answer = await uiWrite(route, form, json, { db, viewer: viewerOf(caller, labels), dispatch });
  if (answer.location !== undefined) return new Response(null, { status: answer.status, headers: { location: answer.location, 'cache-control': 'no-store' } });
  if (answer.json !== undefined) return new Response(JSON.stringify(answer.json), { status: answer.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  return new Response(answer.html ?? '', { status: answer.status, headers: { ...(await htmlHeaders()), 'cache-control': 'no-store' } });
}
