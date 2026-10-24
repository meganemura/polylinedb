/** Shared /ui text rules and markup: escaping, titles, times, chips, form parts, and the page chrome. Reads and writes stay in the page and write modules. */
import type { Actor, Issue, Status } from '../records/index.ts';
import type { DispatchControl } from './dispatch.ts';
import { faviconHref, pageScript, palette, speculationRules, sprite, styles, type IconName } from './ui-assets.ts';

/** human sees every control; agent sees no Dispatch; reader sees no form. The POST handlers check again. */
export type ViewerRole = 'human' | 'agent' | 'reader';
export type Viewer = { actor: Actor; role: ViewerRole; dispatch: DispatchControl; labels: ReadonlyMap<string, string>; now: number };

export const canWrite = (viewer: Viewer): boolean => viewer.role !== 'reader';
export const canDispatch = (viewer: Viewer): boolean => viewer.dispatch !== 'hidden';
/** The person the You lane belongs to, as the viewer reads it. */
export const whose = (viewer: Viewer): string => viewer.role === 'human' ? 'you' : 'the owner';

const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => escapes[character] ?? character);
}

// Some owner issues open with a marker line such as 要対応（owner-action）; the request itself is on the next line.
const ownerMarker = /^#*\s*(?:要対応|判断待ち)[（(][^（()）]*[）)]。?$/;

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

// The issue page keeps a skipped owner marker as the first body line, so the reader still sees it is an owner item.
export function bodyAfterTitle(body: string): string {
  const { lines, title: index, marker } = titleLines(body);
  if (index < 0) return '';
  const rest = lines.slice(index + 1);
  return (marker < 0 ? rest : [lines[marker]!.trim(), ...rest]).join('\n');
}

const ownerPrefix = /^Owner (?:action|decision) for [^:]+:\s*/;
/** A title cut on a word boundary for a sentence, without an "Owner action for X:" prefix. */
export function shortTitle(body: string, limit = 52): string {
  const text = title(body).replace(ownerPrefix, '');
  const points = Array.from(text);
  if (points.length <= limit) return text;
  const cut = points.slice(0, limit).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).replace(/[,:;(]+$/, '')}…`;
}

/** A sentence ends with one stop, even when the title already has one. */
export function sentence(text: string): string {
  return /[.…?!。]$/.test(text) ? text : `${text}.`;
}

const japanese = /[぀-ヿ一-鿿]/;
/** lang="ja" on a string with kana or kanji, so the browser picks Japanese glyphs and line breaks. */
export function lang(text: string): string {
  return japanese.test(text) ? ' lang="ja"' : '';
}

// Workers run in UTC and Japan has no daylight saving time, so a fixed offset avoids output that differs with the runtime's ICU data.
function jst(seconds: number): string {
  return new Date(seconds * 1000 + 9 * 3600_000).toISOString();
}
export function japanTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return `${jst(time / 1000).slice(0, 16).replace('T', ' ')} JST`;
}
export const secondsOf = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
// A stored time that does not parse is shown as unknown rather than failing the whole page.
export const clockTime = (seconds: number): string => Number.isFinite(seconds) ? jst(seconds).slice(11, 16) : 'unknown time';
export const fullTime = (seconds: number): string => Number.isFinite(seconds) ? `${jst(seconds).slice(0, 16).replace('T', ' ')} JST` : 'an unknown time';
export function timeTag(seconds: number, text: string): string {
  if (!Number.isFinite(seconds)) return `<time>${escape(text)}</time>`;
  return `<time datetime="${new Date(seconds * 1000).toISOString()}">${escape(text)}</time>`;
}
const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function dateLine(seconds: number): string {
  const day = new Date(seconds * 1000 + 9 * 3600_000);
  return `${weekdays[day.getUTCDay()]} ${day.getUTCDate()} ${months[day.getUTCMonth()]} · ${clockTime(seconds)} JST`;
}

export function duration(seconds: number): string {
  const s = Math.abs(Math.floor(seconds));
  if (s < 60) return 'under 1 min';
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, '0')} min`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

const numberWords = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
export const numberWord = (count: number): string => numberWords[count] ?? String(count);
export const plural = (count: number, one: string, many: string): string => count === 1 ? one : many;
/** "a", "a and b", "a, b, and c". */
export function joined(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(', ')}, and ${words.at(-1)}`;
}

export const person = (viewer: Viewer, actor: string): string => viewer.labels.get(actor) ?? actor;
/** A project shows its last path segment, so an owner handle never fills the row. */
/** The face of a handle: its first letter on one of eight colors picked from the handle, so a persona looks the same everywhere and nothing is stored. */
export function avatar(handle: string): string {
  let hash = 2166136261;
  for (const unit of handle) hash = Math.imul(hash ^ (unit.codePointAt(0) ?? 0), 16777619) >>> 0;
  return `<span class="who-dot av${hash % 8}" aria-hidden="true">${escape(Array.from(handle)[0]?.toUpperCase() ?? '?')}</span>`;
}
export const shortProject = (project: string): string => project.split('/').filter(Boolean).at(-1) ?? project;

export const issueHref = (id: string): string => `/ui/i/${encodeURIComponent(id)}`;
export function projectHref(tool: string, project: string): string {
  return `/ui/p/${encodeURIComponent(tool)}/${project.split('/').map(segment => encodeURIComponent(segment)).join('/')}`;
}

export function icon(name: IconName, small = false): string {
  return `<svg class="i${small ? ' sm' : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}
export const mono = (id: string): string => `<span class="mono">${escape(id)}</span>`;
export const idLink = (id: string): string => `<a class="mono" href="${escape(issueHref(id))}">${escape(id)}</a>`;

export type Lane = 'you' | 'agents' | 'land' | 'stuck';
const labelLanes: Record<string, Lane> = { 'owner-decision': 'you', 'owner-action': 'you', ready: 'agents', 'main-wait': 'land', 'ready-for-land-queue': 'land' };
/** The labels that move an issue between lanes, in the order chips and filters show them. */
export const workflowLabels = ['owner-decision', 'owner-action', 'ready', 'main-wait', 'main-lock', 'ready-for-land-queue'] as const;

export function labelChip(label: string): string {
  const lane = labelLanes[label];
  if (lane !== undefined) return `<span class="chip c l-${lane}">${escape(label)}</span>`;
  if (label === 'main-lock') return `<span class="chip o">${icon('lock')}main-lock</span>`;
  return `<span class="chip o">${escape(label)}</span>`;
}
export const workflowChips = (issue: Issue): string => workflowLabels.filter(label => issue.labels.includes(label)).map(labelChip).join('');
const statusWords: Record<Status, string> = { open: 'Open', in_progress: 'In progress', deferred: 'Deferred', closed: 'Closed' };
export function statusChip(status: Status): string {
  if (status === 'in_progress') return `<span class="chip c l-agents">${icon('clock')}In progress</span>`;
  if (status === 'closed') return `<span class="chip c l-land">${icon('check')}Closed</span>`;
  return `<span class="chip${status === 'open' ? ' o' : ''}">${statusWords[status]}</span>`;
}
export const statusWord = (status: Status): string => statusWords[status];
export const priorityChip = (priority: number): string => `<span class="chip o">P${priority}</span>`;

export function hidden(fields: Readonly<Record<string, string | number>>): string {
  return Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(String(value))}">`).join('');
}
export const liveLine = '<p class="live" role="status"></p>';
/** A form the fixed script can send in place. clear: false keeps the typed text after success. */
export function liveForm(action: string, fields: Readonly<Record<string, string | number>>, inner: string, clear = true): string {
  return `<form method="post" action="${escape(action)}" data-live${clear ? '' : ' data-clear="no"'}>${hidden(fields)}${inner}${liveLine}</form>`;
}
export function disclose(label: string, name: IconName, inner: string, ghost = false, open = false): string {
  return `<details class="act"${open ? ' open' : ''}><summary class="btn sm${ghost ? ' ghost' : ''}">${icon(name, true)}${escape(label)}</summary><div class="pane">${inner}</div></details>`;
}

export function lanePanel(options: { lane: Lane | null; icon: IconName; heading: string; count?: number; more?: { href: string; label: string };
  rows: string; empty: string; foot?: string; anchor?: string }): string {
  const id = `h-${options.heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  const body = options.rows === '' ? `<div class="empty">${icon('check')}<span>${escape(options.empty)}</span></div>` : `<ul class="rows">${options.rows}</ul>`;
  const more = options.more === undefined ? '' : `<a class="more" href="${escape(options.more.href)}">${escape(options.more.label)}${icon('chev', true)}</a>`;
  return `<section class="panel${options.lane === null ? '' : ` l-${options.lane}`}"${options.anchor === undefined ? '' : ` id="${options.anchor}"`} aria-labelledby="${id}">`
    + `<div class="panel-head">${options.lane === null ? '' : `<span class="lane-ico">${icon(options.icon)}</span>`}<h2 id="${id}">${escape(options.heading)}</h2>`
    + `${options.count === undefined ? '' : `<span class="count">${options.count}</span>`}${more}</div>${body}${options.foot ?? ''}</section>`;
}

export function pageHead(heading: string, line = ''): string {
  return `<div class="page-head"><h1>${escape(heading)}</h1>${line === '' ? '' : `<p>${line}</p>`}</div>`;
}

export type Tab = 'today' | 'agents' | 'posts' | 'landing' | 'stuck' | 'projects';
/** Only Today and Stuck carry a number: items on you, and expired claims plus blocked issues. */
export type TabCounts = { today: number; stuck: number };
const tabs: readonly { key: Tab; href: string; label: string; icon: IconName; lane: Lane | null }[] = [
  { key: 'today', href: '/ui', label: 'Today', icon: 'today', lane: 'you' },
  { key: 'agents', href: '/ui/agents', label: 'Agents', icon: 'agents', lane: 'agents' },
  { key: 'posts', href: '/ui/posts', label: 'Posts', icon: 'comment', lane: null },
  { key: 'landing', href: '/ui/landing', label: 'Landing', icon: 'land', lane: 'land' },
  { key: 'stuck', href: '/ui/stuck', label: 'Stuck', icon: 'stuck', lane: 'stuck' },
  { key: 'projects', href: '/ui/projects', label: 'Projects', icon: 'projects', lane: null },
];
const roleWords: Record<ViewerRole, string> = { human: 'owner', agent: 'agent', reader: 'reader' };

export function document(page: { title: string; body: string; viewer: Viewer; counts: TabCounts; tab?: Tab; bar?: string; footer?: string }): string {
  const nav = tabs.map(tab => {
    const count = tab.key === 'today' ? page.counts.today : tab.key === 'stuck' ? page.counts.stuck : 0;
    const badge = count > 0 ? `<span class="n" aria-hidden="true">${count}</span>` : '';
    const current = tab.key === page.tab ? ' aria-current="page"' : '';
    return `<a${tab.lane === null ? '' : ` class="l-${tab.lane}"`} href="${tab.href}"${current} aria-label="${count > 0 ? `${tab.label}, ${count}` : tab.label}">${icon(tab.icon)}${tab.label}${badge}</a>`;
  }).join('');
  const plus = canWrite(page.viewer) ? `<a class="ibtn plus" href="/ui/new" aria-label="New issue">${icon('plus')}</a>` : '';
  const footer = page.footer ?? `As of ${fullTime(page.viewer.now)}. Every time on this page is JST.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="${palette.light.bg}">
<meta name="theme-color" content="${palette.dark.bg}" media="(prefers-color-scheme: dark)">
<meta name="robots" content="noindex">
<title>${escape(page.title)} · pd</title>
<link rel="icon" type="image/svg+xml" href="${faviconHref}">
<script type="speculationrules">${speculationRules}</script>
<style>${styles}</style>
</head>
<body${page.bar ? ' class="has-bar"' : ''}>
${sprite}
<a class="skip" href="#main">Skip to content</a>
<header class="top">
<a class="brand" href="/ui" aria-label="pd, Today"><b>pd</b><span>polylinedb</span></a>
<nav class="tabs" aria-label="Main">${nav}</nav>
<form class="search-inline" action="/ui/search" method="get" role="search"><input type="search" name="q" placeholder="Search issues or ids" aria-label="Search issues"></form>
<span class="who">${page.viewer.labels.has(page.viewer.actor.id) ? `<b>${escape(person(page.viewer, page.viewer.actor.id))}</b> ` : ''}${roleWords[page.viewer.role]}</span>
<a class="ibtn s" href="/ui/search" aria-label="Search">${icon('search')}</a>
${plus}
</header>
<main id="main">
${page.bar ?? ''}${page.body}
<p class="foot">${footer}</p>
</main>
<script>${pageScript}</script>
</body>
</html>`;
}
