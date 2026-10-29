/** Composes each /ui page from data the entry module already read. Nothing here reads the store or writes. */
import { blockerIsActive, type ActivityEvent, type ActivityPage, type Attention, type ClaimDisplay, type Comment, type Issue, type IssueLink, type PostPage,
  type ProjectIssue, type ProjectSummary, type Status, type WatchedLease } from '../../records/index.ts';
import { avatar, bodyAfterTitle, canDispatch, canWrite, clockTime, disclose, document, duration, escape, fullTime, hidden, icon, idLink, issueHref, japanTime,
  joined, labelChip, lang, lanePanel, liveForm, mono, pageHead, person, plural, priorityChip, projectHref, secondsOf, shortProject, shortTitle, statusChip,
  statusWord, timeTag, title, whose, workflowLabels, type TabCounts, type Viewer } from './html.ts';
import { flash, hero, sinceYesterday, type DoneKind } from './brief.ts';
import { blockedRow, claimRow, commentForm, decideForm, dispatchForm, dispatchLine, doneForm, expiredRow, holderName, leaseBar, plainRow,
  queueRow, readyRow, unblockForm, youRow } from './rows.ts';
import { pageLimit, stuckCount, type Lanes, type QueueItem } from './today.ts';

export const tabCounts = (lanes: Lanes): TabCounts => ({ today: lanes.you.length, stuck: stuckCount(lanes) });
const rest = (text: string): string => `<p class="rest">${text}</p>`;
const moreOn = (count: number, label: string, href: string): string => count > 0 ? rest(`${count} more on the <a href="${href}">${label}</a> page.`) : '';
const limitNote = (shown: number, total: number, noun: string): string => total > shown
  ? rest(`Showing ${shown} of ${total}. More exist; narrow it in the project page.`)
  : rest(`All ${total} ${noun} shown. A page lists at most ${pageLimit}.`);

export function todayPage(lanes: Lanes, viewer: Viewer, done: { kind: DoneKind; id: string; issue: Issue | null } | null): string {
  const you = lanes.you.slice(0, pageLimit).map(item => youRow(item, viewer)).join('');
  const youFoot = (lanes.you.length > 0 ? '<p class="panel-note">Decisions first, then actions. Highest priority, then the longest wait.</p>' : '')
    + (lanes.you.length > pageLimit ? rest(`Showing ${pageLimit} of ${lanes.you.length}.`) : '')
    + (lanes.parked > 0 ? rest(`${lanes.parked} deferred ${plural(lanes.parked, 'item is', 'items are')} out of sight until reopened.`) : '');
  const agents = lanes.claims.slice(0, 3).map(claim => claimRow(claim, viewer, '/ui', false)).join('') + lanes.ready.slice(0, 2).map(issue => readyRow(issue, viewer, '/ui')).join('');
  const agentsMore = Math.max(0, lanes.claims.length - 3) + Math.max(0, lanes.ready.length - 2);
  const queue = lanes.queue.slice(0, 3).map(item => queueRow(item)).join('');
  const queueFoot = moreOn(lanes.queue.length - 3, 'Landing', '/ui/landing')
    + (lanes.queue.length > 0 ? `<p class="panel-note">${icon('lock', true)} Landing is a git push from your machine. This page cannot land the queue.</p>` : '');
  const staleRow = lanes.staleTotal === 0 ? '' : staleSummary(lanes);
  const stuck = lanes.expired.slice(0, pageLimit).map(row => expiredRow(row, viewer, '/ui')).join('') + lanes.blocked.slice(0, 2).map(row => blockedRow(row, viewer, '/ui')).join('') + staleRow;
  const panels = lanePanel({ lane: 'you', icon: 'you', heading: 'You', count: lanes.you.length, rows: you, empty: `Nothing waits on ${whose(viewer)}. A new owner-decision or owner-action issue shows up here first.`, foot: youFoot })
    + lanePanel({ lane: 'agents', icon: 'agents', heading: 'Agents', count: lanes.claims.length, more: { href: '/ui/agents', label: 'All' }, rows: agents,
      empty: 'No agent holds a claim, and no ready issue is waiting for one.', foot: moreOn(agentsMore, 'Agents', '/ui/agents') })
    + lanePanel({ lane: 'land', icon: 'land', heading: 'Landing', count: lanes.queue.length, more: { href: '/ui/landing', label: 'All' }, rows: queue, empty: 'Nothing waits on queue for main.', foot: queueFoot })
    + lanePanel({ lane: 'stuck', icon: 'stuck', heading: 'Stuck', count: stuckCount(lanes), more: { href: '/ui/stuck', label: 'All' }, rows: stuck, empty: 'Nothing looks stuck.',
      foot: moreOn(lanes.blockedTotal - Math.min(2, lanes.blocked.length), 'Stuck', '/ui/stuck') });
  const since = `<section class="panel closing" aria-labelledby="h-since"><div class="panel-head"><h2 id="h-since">Since yesterday</h2><a class="more" href="/ui/activity">Feed${icon('chev', true)}</a></div>`
    + `${rest(sinceYesterday(lanes.since, viewer))}</section>`;
  const note = viewer.role === 'reader' ? `<p class="role-note">${icon('lock', true)} Signed in as a reader. This page shows what waits on the owner and has no controls.</p>` : '';
  const flashed = done === null ? '' : flash(done.kind, done.issue, done.id, lanes, viewer);
  return document({ title: 'Today', viewer, counts: tabCounts(lanes), tab: 'today',
    body: `${note}${flashed}<div class="today">${hero(lanes, viewer)}<div><div class="board">${panels}</div>${since}</div></div>`,
    footer: `Composed by rule from the store at ${timeTag(viewer.now, `${clockTime(viewer.now)} JST`)}. Reload for a new one.` });
}

function staleSummary(lanes: Lanes): string {
  const projects = new Map<string, number>();
  for (const row of lanes.stale) projects.set(row.issue.project, (projects.get(row.issue.project) ?? 0) + 1);
  const [top, count] = [...projects].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  return `<li class="row l-stuck" data-row><div class="meta"><span class="chip c l-stuck">Stale</span><span>in progress, no live claim</span></div>`
    + `<a class="title" href="/ui/stuck#stale">${lanes.staleTotal} started ${plural(lanes.staleTotal, 'issue has', 'issues have')} no live claim</a>`
    + (count > 0 ? `<p class="sub-line">${count} of the ${lanes.stale.length} shown ${plural(lanes.stale.length, 'is', 'are')} in ${escape(shortProject(top))}.</p>` : '') + '</li>';
}

function agentsTabs(current: 'now' | 'feed'): string {
  const mark = (tab: 'now' | 'feed') => tab === current ? ' aria-current="page"' : '';
  return `<nav class="subtabs" aria-label="Agents views"><a href="/ui/agents"${mark('now')}>Now</a><a href="/ui/activity"${mark('feed')}>Feed</a></nav>`;
}

export function agentsPage(lanes: Lanes, viewer: Viewer): string {
  const locks = lanes.locks.map(lock => `<p class="role-note">${icon('lock', true)} ${escape(holderName(viewer, lock))} holds the main lock for ${escape(shortProject(lock.issue.project))} `
    + `(${idLink(lock.issue.id)}) until ${timeTag(lock.expiresAt, clockTime(lock.expiresAt))}, so a push to main is under way.</p>`).join('');
  const claims = lanes.claims.slice(0, pageLimit);
  const holding = lanePanel({ lane: 'agents', icon: 'agents', heading: 'Holding', count: lanes.claims.length, rows: claims.map(claim => claimRow(claim, viewer, '/ui/agents')).join(''),
    empty: 'No agent holds an issue.', foot: lanes.claims.length === 0 ? '' : rest(lanes.claims.length > pageLimit ? `Showing ${pageLimit} of ${lanes.claims.length}, soonest expiry first.`
      : `All ${lanes.claims.length} active ${plural(lanes.claims.length, 'claim is', 'claims are')} shown, soonest expiry first. A page lists at most ${pageLimit}.`) });
  const ready = lanes.ready.slice(0, pageLimit);
  const readyPanel = lanePanel({ lane: 'agents', icon: 'send', heading: 'Ready, no agent', count: lanes.ready.length, anchor: 'ready', rows: ready.map(issue => readyRow(issue, viewer, '/ui/agents')).join(''),
    empty: 'Every ready issue has an agent.', foot: lanes.ready.length === 0 ? '' : rest(lanes.ready.length > pageLimit ? `Showing ${pageLimit} of ${lanes.ready.length}.` : `All ${lanes.ready.length} shown. A page lists at most ${pageLimit}.`) });
  const elsewhere = lanes.expired.length + lanes.staleTotal === 0 ? '' : `<p class="role-note">${lanes.expired.length} expired ${plural(lanes.expired.length, 'claim', 'claims')} and ${lanes.staleTotal} started `
    + `${plural(lanes.staleTotal, 'issue', 'issues')} with no live claim are on the <a href="/ui/stuck">Stuck</a> page.</p>`;
  return document({ title: 'Agents', viewer, counts: tabCounts(lanes), tab: 'agents',
    body: pageHead('Agents', 'Who holds what, and when each lease ends.') + agentsTabs('now') + locks + `<div class="board">${holding}${readyPanel}</div>` + elsewhere });
}

const eventWords: Record<string, string> = {
  created: 'Created', updated: 'Updated', status_changed: 'Status changed', commented: 'Commented', comment_edited: 'Comment edited', claim_acquired: 'Claimed',
  claim_released: 'Released', dependency_added: 'Blocker added', dependency_removed: 'Blocker removed', became_ready: 'Became ready',
  starred: 'Starred', unstarred: 'Unstarred',
};
const eventLanes: Record<string, { lane: string; icon: 'plus' | 'check' | 'agents' | 'comment' | 'edit' | 'link' }> = {
  created: { lane: '', icon: 'plus' }, claim_acquired: { lane: 'agents', icon: 'agents' }, claim_released: { lane: 'agents', icon: 'agents' },
  commented: { lane: '', icon: 'comment' }, became_ready: { lane: 'agents', icon: 'check' }, dependency_added: { lane: 'stuck', icon: 'link' }, dependency_removed: { lane: '', icon: 'link' },
};

function activityRow(event: ActivityEvent, viewer: Viewer): string {
  const words = event.relation === 'lands_after' ? (event.kind === 'dependency_added' ? 'Land order added' : 'Land order removed')
    : event.kind === 'updated' && event.fields.length > 0 ? `Updated ${event.fields.join(', ')}` : eventWords[event.kind] ?? event.kind;
  const style = eventLanes[event.kind] ?? { lane: '', icon: 'edit' as const };
  const text = title(event.body);
  return `<li class="row${style.lane === '' ? '' : ` l-${style.lane}`}"><div class="meta"><span class="chip${style.lane === '' ? '' : ' c'}">${icon(style.icon)}${escape(words)}</span>`
    + `${mono(event.issue_id)}<span>${escape(shortProject(event.project))}</span><span>${escape(person(viewer, event.actor))}</span><span>${timeTag(event.occurred_at, fullTime(event.occurred_at))}</span></div>`
    + `<a class="title"${lang(text)} href="${escape(issueHref(event.issue_id))}">${escape(text)}</a></li>`;
}

export type ActivityCursor = { since: number; incarnation: string };
const activityHref = (since: number, incarnation: string): string => `/ui/activity?after=${since}&incarnation=${encodeURIComponent(incarnation)}`;

export function activityPage(page: ActivityPage | { problem: string }, after: ActivityCursor | null, viewer: Viewer, counts: TabCounts): string {
  let panel: string;
  if ('problem' in page) {
    panel = `<p class="role-note">${escape(page.problem)} Start again from the <a href="/ui/activity">latest activity</a>.</p>`;
  } else if (after === null) {
    panel = lanePanel({ lane: null, icon: 'clock', heading: 'Newest first', count: page.events.length, rows: page.events.map(event => activityRow(event, viewer)).join(''), empty: 'Nothing has happened yet.',
      foot: rest(`Showing the newest ${page.events.length} events${page.more ? '; older events are not shown' : ''}. Event ${page.latest} is the newest. `
        + `Keep <a href="${escape(activityHref(page.latest, page.incarnation))}">this link</a> to see only what happens after it.`) });
  } else {
    const last = page.events.at(-1)?.seq ?? after.since;
    panel = lanePanel({ lane: null, icon: 'clock', heading: `Since event ${after.since}, oldest first`, count: page.events.length, rows: page.events.map(event => activityRow(event, viewer)).join(''),
      empty: 'Nothing new since this link.', foot: rest(page.more ? `<a href="${escape(activityHref(last, page.incarnation))}">Newer events</a>`
        : `Up to date. Keep <a href="${escape(activityHref(last, page.incarnation))}">this link</a> to see only what happens after now.`) });
  }
  return document({ title: 'Agent feed', viewer, counts, tab: 'agents',
    body: pageHead('Agents', 'Every change in the store, as the change feed records it.') + agentsTabs('feed') + panel });
}

/** What /ui/posts shows: the chosen filters as typed, the choices for each, and the page or why it could not be read. A null project is every project. */
export type PostsView = { project: string | null; projects: readonly string[]; handle: string; handles: readonly string[]; minStars: number; page: PostPage | { problem: string } };
const minStarChoices = [0, 1, 2, 3] as const;
function postsHref(view: PostsView, after: string): string {
  const query = new URLSearchParams();
  if (view.project !== null) query.set('project', view.project);
  if (view.handle !== '') query.set('handle', view.handle);
  if (view.minStars > 0) query.set('min_stars', String(view.minStars));
  query.set('after', after);
  return `/ui/posts?${query.toString()}`;
}

function postRow(post: PostPage['posts'][number], project: string | undefined, viewer: Viewer, back: string): string {
  const handle = post.handle ?? '';
  const text = title(post.body);
  const more = bodyAfterTitle(post.body).trim() === '' ? '' : ` <a href="${escape(issueHref(post.issue_id))}#comments">More</a>`;
  // A person stars as their actor, so the star they can remove is the one under their actor id.
  const mine = post.starrers.includes(viewer.actor.id);
  const toggle = !canWrite(viewer) ? '' : `<form method="post" action="/ui/i/${escape(post.issue_id)}/star">${hidden({ return: `${back}#p-${post.id}`, comment: post.id, star: mine ? 'remove' : 'add' })}`
    + `<button class="btn sm${mine ? '' : ' ghost'}" aria-pressed="${mine}">${mine ? '★ Starred' : '☆ Star'}</button></form>`;
  const who = post.starrers.length === 0 ? '' : `<span>${escape(joined(post.starrers.map(name => person(viewer, name))))}${post.stars > post.starrers.length ? ` and ${post.stars - post.starrers.length} more` : ''}</span>`;
  return `<li class="row post" id="p-${escape(post.id)}"><div class="meta">${avatar(handle)}<b>${escape(handle)}</b>`
    + (post.via === null ? '' : `<span>via ${escape(post.via)}</span>`) + idLink(post.issue_id) + (project === undefined ? '' : `<span>${escape(shortProject(project))}</span>`)
    + `<span>${timeTag(secondsOf(post.created_at), fullTime(secondsOf(post.created_at)))}</span>${post.reply_to === null ? '' : '<span>reply</span>'}</div>`
    + `<p class="says"${lang(text)}>${escape(text)}${more}</p>`
    + `<div class="stars"><span>${post.stars} ${plural(post.stars, 'star', 'stars')}</span>${who}${toggle}</div></li>`;
}

/** posts carries the project of each post's issue, so the all-projects list can say where each one was written. */
export function postsPage(view: PostsView, projectOf: ReadonlyMap<string, string>, viewer: Viewer, counts: TabCounts, back: string): string {
  const option = (value: string, label: string, chosen: boolean) => `<option value="${escape(value)}"${chosen ? ' selected' : ''}>${escape(label)}</option>`;
  const projects = option('', 'All projects', view.project === null) + view.projects.map(project => option(project, project, project === view.project)).join('');
  const handles = option('', 'Anyone', view.handle === '') + view.handles.map(handle => option(handle, handle, handle === view.handle)).join('');
  const stars = minStarChoices.map(count => option(String(count), count === 0 ? 'Any' : `${count} or more`, count === view.minStars)).join('');
  const filters = `<form class="filters" action="/ui/posts" method="get"><div class="field"><label for="pf-project">Project</label><select id="pf-project" name="project">${projects}</select></div>`
    + `<div class="field"><label for="pf-handle">Persona</label><select id="pf-handle" name="handle">${handles}</select></div>`
    + `<div class="field"><label for="pf-stars">Stars</label><select id="pf-stars" name="min_stars">${stars}</select></div><button class="btn sm">Show</button></form>`;
  let panel: string;
  if ('problem' in view.page) panel = `<p class="role-note">${escape(view.page.problem)} Start again from the <a href="/ui/posts">newest posts</a>.</p>`;
  else {
    const page = view.page;
    panel = lanePanel({ lane: null, icon: 'comment', heading: 'Newest first', count: page.posts.length,
      rows: page.posts.map(post => postRow(post, view.project === null ? projectOf.get(post.issue_id) : undefined, viewer, back)).join(''),
      empty: 'No post matches. A post is a comment written with a handle.',
      foot: page.next_cursor === null ? '' : rest(`<a href="${escape(postsHref(view, page.next_cursor))}">Older posts</a>`) });
  }
  return document({ title: 'Posts', viewer, counts, tab: 'posts',
    body: pageHead('Posts', 'One-line lessons agents post, newest first. Star the ones worth keeping.') + filters + panel });
}

function orderForm(item: QueueItem, queue: readonly QueueItem[]): string {
  const choices = queue.filter(other => other.issue.id !== item.issue.id && other.issue.project === item.issue.project && !item.after.includes(other.issue.id));
  const remove = item.after.map(id => liveForm(`/ui/i/${item.issue.id}/land-order`, { return: '/ui/landing', op: 'clear', after: id, 'v.land': item.revision },
    `<button class="btn sm ghost" data-confirm="Tap again to clear">Clear “after ${escape(id)}”</button>`, false)).join('');
  const add = choices.length === 0 ? '<p class="hint">No other issue of this project is on the queue.</p>'
    : liveForm(`/ui/i/${item.issue.id}/land-order`, { return: '/ui/landing', op: 'set', 'v.land': item.revision },
      `<div class="field"><label for="lo-${escape(item.issue.id)}">Lands after</label><select id="lo-${escape(item.issue.id)}" name="after">${choices.map(other => `<option value="${escape(other.issue.id)}">${escape(other.issue.id)} ${escape(shortTitle(other.issue.body, 40))}</option>`).join('')}</select></div>`
      + '<button class="btn sm">Set order</button>', false);
  return remove + add;
}

export function landingPage(lanes: Lanes, viewer: Viewer, results: string): string {
  const groups = new Map<string, QueueItem[]>();
  for (const item of lanes.queue) groups.set(`${item.issue.tool}\n${item.issue.project}`, [...(groups.get(`${item.issue.tool}\n${item.issue.project}`) ?? []), item]);
  const sections = [...groups].map(([key, items]) => {
    const [tool = '', project = ''] = key.split('\n');
    const name = shortProject(project);
    const lockIssue = lanes.lockIssues.find(issue => issue.tool === tool && issue.project === project);
    const held = lockIssue === undefined ? undefined : lanes.locks.find(lock => lock.issue.id === lockIssue.id);
    const lock = lockIssue === undefined ? `No main-lock issue exists for ${escape(name)}.`
      : held === undefined ? `The main lock (${idLink(lockIssue.id)}) is free.`
      : `${escape(holderName(viewer, held))} holds the main lock (${idLink(lockIssue.id)}) until ${timeTag(held.expiresAt, clockTime(held.expiresAt))}. Wait for it before you push.`;
    const rows = items.map(item => queueRow(item, canWrite(viewer) ? disclose('Order', 'sliders', orderForm(item, lanes.queue), true) : '')).join('');
    const command = `<div class="rest"><p>${icon('lock', true)} ${lock} To land all ${items.length} in this order, run this from your machine:</p>`
      + `<pre class="cmd">git fetch origin queue &amp;&amp; git push origin origin/queue:refs/heads/main</pre></div>`;
    const checklist = !canWrite(viewer) ? '' : `<div class="rest"><form method="post" action="/ui/landing/landed" class="landed">`
      + `<input type="hidden" name="return" value="/ui/landing">`
      + items.map(item => `<label class="check"><input type="checkbox" name="landed" value="${escape(item.issue.id)}"><span>${mono(item.issue.id)} ${escape(shortTitle(item.issue.body, 60))}</span></label>`
        + `<input type="hidden" name="v.labels.${escape(item.issue.id)}" value="${item.issue.versions.labels}">`).join('')
      + `<button class="btn sm l-land">${icon('check', true)}Mark landed</button><p class="hint">After your push: removes main-wait and comments “Landed on main.” on each ticked issue.</p></form></div>`;
    return lanePanel({ lane: 'land', icon: 'land', heading: name, count: items.length, rows, empty: '', foot: command + checklist });
  }).join('');
  const note = `<div class="role-note">${icon('lock', true)} <b>Landing is a git push from your machine.</b> This page orders the queue and records what landed. It cannot push.</div>`;
  const empty = lanes.queue.length === 0 ? lanePanel({ lane: 'land', icon: 'land', heading: 'On queue, not on main', count: 0, rows: '', empty: 'Nothing waits on queue for main.' }) : '';
  return document({ title: 'Landing', viewer, counts: tabCounts(lanes), tab: 'landing',
    body: pageHead('Landing', 'Issues enqueued on the queue branch, waiting for main, in land order.') + results + note + `<div class="board">${sections}${empty}</div>` });
}

export function stuckPage(lanes: Lanes, viewer: Viewer): string {
  const expired = lanePanel({ lane: 'stuck', icon: 'warn', heading: 'Claim expired', count: lanes.expired.length, rows: lanes.expired.slice(0, pageLimit).map(row => expiredRow(row, viewer, '/ui/stuck')).join(''),
    empty: 'No claim has expired on a started issue or after an error.', foot: lanes.expired.length > pageLimit ? rest(`Showing ${pageLimit} of ${lanes.expired.length}.`) : '' });
  const silentRows = lanes.silent.slice(0, pageLimit).map(row => plainRow(row.issue, viewer, `<p class="sub-line">${silentClaim(row, viewer)}</p>`, true)).join('');
  const silent = lanePanel({ lane: 'stuck', icon: 'stuck', heading: 'Live claim, quiet or errored', count: lanes.silent.length, rows: silentRows,
    empty: 'Every live claim reported work recently.' });
  const blocked = lanePanel({ lane: 'stuck', icon: 'link', heading: 'Waiting on unfinished work', count: lanes.blockedTotal, rows: lanes.blocked.slice(0, pageLimit).map(row => blockedRow(row, viewer, '/ui/stuck')).join(''),
    empty: 'Nothing waits on a blocker.', foot: lanes.blockedTotal === 0 ? '' : limitNote(Math.min(pageLimit, lanes.blocked.length), lanes.blockedTotal, plural(lanes.blockedTotal, 'is', 'are')) });
  const staleRows = lanes.stale.slice(0, pageLimit).map(row => plainRow(row.issue, viewer, `<p class="sub-line">${staleClaim(row.claim, viewer)}</p>`, true)).join('');
  const stale = lanePanel({ lane: 'stuck', icon: 'stuck', heading: 'Started, no live claim', count: lanes.staleTotal, anchor: 'stale', rows: staleRows,
    empty: 'Every started issue has a live claim.', foot: lanes.staleTotal === 0 ? '' : limitNote(Math.min(pageLimit, lanes.stale.length), lanes.staleTotal, plural(lanes.staleTotal, 'is', 'are'))
      + '<p class="panel-note">Open an issue to set it back to open or send it to an agent.</p>' });
  return document({ title: 'Stuck', viewer, counts: tabCounts(lanes), tab: 'stuck',
    body: pageHead('Stuck', 'Expired leases, work behind a blocker, and started issues nobody holds.') + `<div class="board">${expired}${silent}${blocked}</div><div class="closing">${stale}</div>` });
}

function silentClaim(row: WatchedLease, viewer: Viewer): string {
  const name = escape(holderName(viewer, row.claim));
  const last = row.run.last;
  if (row.run.state === 'errored' && last) return `${name} reported an error ${duration(viewer.now - last.at)} ago: ${escape(last.text)}`;
  if (!last) return `${name} has reported nothing since it claimed this ${duration(viewer.now - row.acquiredAt)} ago; the lease is still live.`;
  return `${name} has been quiet for ${duration(viewer.now - last.at)}; the lease is still live. Last: ${escape(last.text)}`;
}

function staleClaim(claim: ClaimDisplay, viewer: Viewer): string {
  if (claim.state === 'never_claimed') return 'Never claimed.';
  const name = escape(holderName(viewer, claim));
  if (claim.state === 'released' && claim.releasedAt !== null) return `${name} released it ${duration(viewer.now - claim.releasedAt)} ago.`;
  return `${name}’s claim ended ${duration(viewer.now - claim.expiresAt)} ago.`;
}

export function projectsPage(projects: readonly ProjectSummary[], more: boolean, attention: Attention, viewer: Viewer, counts: TabCounts): string {
  const waiting = new Map<string, number>();
  for (const row of attention.issues) {
    if (row.issue.status === 'closed' || row.issue.status === 'deferred' || !row.labels.some(label => label === 'owner-decision' || label === 'owner-action')) continue;
    const key = `${row.issue.tool}\n${row.issue.project}`;
    waiting.set(key, (waiting.get(key) ?? 0) + 1);
  }
  const rows = projects.map(summary => {
    const onYou = waiting.get(`${summary.tool}\n${summary.project}`) ?? 0;
    const updated = secondsOf(summary.lastUpdatedAt);
    return `<li class="row" data-row><div class="meta"><span>${escape(summary.tool)}</span>${onYou > 0 ? `<span class="chip c l-you">${onYou} on ${whose(viewer)}</span>` : ''}</div>`
      + `<a class="title" href="${escape(projectHref(summary.tool, summary.project))}">${escape(shortProject(summary.project))}</a>`
      + `<div class="stat"><span><b>${summary.counts.open}</b>open</span><span><b>${summary.counts.in_progress}</b>in progress</span><span><b>${summary.counts.deferred}</b>deferred</span><span><b>${summary.counts.closed}</b>closed</span></div>`
      + `<div class="meta"><span>Updated ${timeTag(updated, fullTime(updated))}</span></div></li>`;
  }).join('');
  const foot = more ? rest(`The ${projects.length} most recently updated projects are shown. More projects are not shown.`) : rest(`All ${projects.length} projects are shown, newest update first.`);
  return document({ title: 'Projects', viewer, counts, tab: 'projects',
    body: pageHead('Projects', 'One tool and project per row, newest update first.') + lanePanel({ lane: null, icon: 'projects', heading: 'Newest update first', count: projects.length, rows, empty: 'No projects yet.', foot }) });
}

const projectStatuses = ['open', 'in_progress', 'deferred', 'closed'] as const;
export function projectPage(page: { tool: string; project: string; status?: Status; label?: string; issues: readonly ProjectIssue[]; more: boolean; closed: readonly Issue[] }, viewer: Viewer, counts: TabCounts): string {
  const href = (status?: Status, label?: string) => {
    const params = new URLSearchParams();
    if (status !== undefined) params.set('status', status);
    if (label !== undefined) params.set('label', label);
    const query = params.toString();
    return `${projectHref(page.tool, page.project)}${query === '' ? '' : `?${query}`}`;
  };
  const chip = (target: string, text: string, current: boolean) => `<a href="${escape(target)}"${current ? ' aria-current="page"' : ''}>${escape(text)}</a>`;
  const states = `<div class="filter" role="group" aria-label="State"><span class="lbl">State</span>${chip(href(undefined, page.label), 'Unfinished', page.status === undefined)}`
    + projectStatuses.map(status => chip(href(status, page.label), statusWord(status), page.status === status)).join('') + '</div>';
  const marks = `<div class="filter" role="group" aria-label="Mark"><span class="lbl">Mark</span>${chip(href(page.status), 'Any label', page.label === undefined)}`
    + workflowLabels.map(label => chip(href(page.status, label), label, page.label === label)).join('') + '</div>';
  const rows = page.issues.map(row => {
    const notes = [
      ...(row.claim.state === 'active' ? [`${escape(holderName(viewer, row.claim))} until ${timeTag(row.claim.expiresAt, clockTime(row.claim.expiresAt))}`] : []),
      ...(row.openBlockers > 0 ? [`${icon('link', true)} waits on ${row.openBlockers}`] : []),
    ];
    return plainRow(row.issue, viewer, notes.length === 0 ? '' : `<p class="sub-line">${notes.join(' · ')}</p>`);
  }).join('');
  const filtered = page.status !== undefined || page.label !== undefined;
  const list = lanePanel({ lane: null, icon: 'projects', heading: page.status === undefined ? 'Unfinished' : statusWord(page.status), count: page.issues.length, rows,
    empty: filtered ? 'Nothing matches.' : 'Nothing is open.', foot: page.more ? rest('Showing 100. More match; narrow the filter.') : rest(`All ${page.issues.length} shown. A page lists at most 100.`) });
  const closed = lanePanel({ lane: 'land', icon: 'check', heading: 'Recently closed', count: page.closed.length, rows: page.closed.map(issue => plainRow(issue, viewer,
    issue.closed_at != null ? `<p class="sub-line">Closed ${timeTag(secondsOf(issue.closed_at), fullTime(secondsOf(issue.closed_at)))} by ${escape(person(viewer, issue.closed_by ?? ''))}</p>` : '<p class="sub-line">No close record; the time below is the last update.</p>')).join(''),
    empty: 'Nothing has closed yet.', foot: rest('Newest close first, at most 50. A row without a close record sorts after those with one.') });
  const create = canWrite(viewer) ? `<a class="btn sm" href="/ui/new?project=${encodeURIComponent(`${page.tool}\n${page.project}`)}">${icon('plus', true)}New issue here</a>` : '';
  return document({ title: shortProject(page.project), viewer, counts, tab: 'projects',
    body: `<nav class="crumbs" aria-label="Breadcrumb"><a href="/ui/projects">${icon('back', true)}Projects</a></nav>`
      + pageHead(shortProject(page.project), `${escape(page.tool)} · unfinished issues, then the latest closed`) + states + marks + `<div class="board">${list}${closed}</div><p class="closing">${create}</p>` });
}

export function searchPage(query: string, hits: readonly Issue[], more: boolean, rejected: boolean, viewer: Viewer, counts: TabCounts): string {
  const form = `<form action="/ui/search" method="get" role="search"><div class="field"><label for="q">Issue id or words from the text</label>`
    + `<input id="q" type="search" name="q" value="${escape(query)}" autocapitalize="none" spellcheck="false"></div><button class="btn">${icon('search', true)}Search</button></form>`;
  const trimmed = query.trim();
  const empty = trimmed === '' ? 'Type an issue id or words from the text.' : rejected ? 'That search is too long or contains a null character.' : 'No matches. Try a shorter word.';
  const panel = trimmed === '' ? '' : lanePanel({ lane: null, icon: 'search', heading: `Matches for “${trimmed.slice(0, 80)}”`, count: hits.length,
    rows: hits.map(issue => plainRow(issue, viewer, '', true)).join(''), empty,
    foot: hits.length === 0 ? '' : rest(more ? `Showing ${hits.length} matches. More exist; add a word to narrow them.` : `${hits.length} ${plural(hits.length, 'match', 'matches')}.`) });
  return document({ title: 'Search', viewer, counts, body: pageHead('Search', 'Literal text in the issue text and comments, or an issue id.') + form + (trimmed === '' ? `<p class="hint">${empty}</p>` : `<div class="closing">${panel}</div>`) });
}

/** What the person typed for a project that has no issue yet, kept across a refusal. */
export type FreshProject = { tool: string; project: string; prefix: string };

/** The new-issue form. The project select ends with "New project", whose three fields CSS shows only while it is chosen. */
export function newPage(projects: readonly ProjectSummary[], selected: string | null, viewer: Viewer, counts: TabCounts, problem = '', draft = '', fresh: FreshProject = { tool: '', project: '', prefix: '' }): string {
  const starting = projects.length === 0 || selected === newProject;
  const options = projects.map(summary => {
    const value = `${summary.tool}\n${summary.project}`;
    return `<option value="${escape(value)}"${value === selected ? ' selected' : ''}>${escape(shortProject(summary.project))} · ${escape(summary.tool)}</option>`;
  }).join('');
  const toggles = (name: string, values: readonly (string | number)[], checked: string | number | null, type: 'radio' | 'checkbox', text: (value: string | number) => string) =>
    values.map(value => `<label class="tog"><input type="${type}" name="${name}" value="${value}"${value === checked ? ' checked' : ''}><span>${escape(text(value))}</span></label>`).join('');
  const send = canDispatch(viewer) && viewer.dispatch === 'ready' ? `<button class="btn ghost" name="then" value="dispatch">${icon('send', true)}Create and dispatch</button>` : '';
  const text = (id: string, name: keyof FreshProject, label: string, hint: string) =>
    `<div class="field"><label for="${id}">${label}</label><input id="${id}" type="text" name="new.${name}" value="${escape(fresh[name])}" placeholder="${hint}" autocapitalize="none" autocomplete="off" spellcheck="false"></div>`;
  const form = `<form method="post" action="/ui/new" class="card">${problem === '' ? '' : `<p class="role-note" role="alert">${escape(problem)}</p>`}`
    + `<div class="field"><label for="pj">Project</label><select id="pj" name="project">${options}<option value="${newProject}"${starting ? ' selected' : ''}>New project…</option></select></div>`
    + `<fieldset class="newproj"><legend>New project</legend>`
    + text('nt', 'tool', 'Tool', 'e.g. polylinedb') + text('np', 'project', 'Project', 'e.g. owner/repo')
    + text('nx', 'prefix', 'Id prefix', 'e.g. pd')
    + '<p class="hint">Lowercase letters and digits, starting with a letter. Projects that share a prefix share one id sequence, so pick one no other project uses.</p></fieldset>'
    + `<div class="field"><label for="bd">Text. The first line is the title.</label><textarea id="bd" name="body" rows="8" required placeholder="Short title on the first line&#10;&#10;What and why.">${escape(draft)}</textarea></div>`
    + `<div class="field"><span class="lbl">Type</span><div class="togs">${toggles('type', ['task', 'bug', 'feature', 'chore', 'epic'], 'task', 'radio', String)}</div></div>`
    + `<div class="field"><span class="lbl">Priority</span><div class="togs">${toggles('priority', [0, 1, 2, 3, 4], 2, 'radio', value => `P${value}`)}</div></div>`
    + `<div class="field"><span class="lbl">Labels</span><div class="togs">${toggles('labels', ['ready', 'owner-decision', 'owner-action'], null, 'checkbox', String)}</div></div>`
    + '<div class="field"><label for="pa">Parent epic (optional)</label><input id="pa" type="text" name="parent" placeholder="e.g. pd-65" autocapitalize="none" autocomplete="off" spellcheck="false"></div>'
    + `<div class="btn-row"><button class="btn">${icon('plus', true)}Create</button>${send}</div></form>`;
  return document({ title: 'New issue', viewer, counts, body: pageHead('New issue', 'Creates the issue, then opens it.') + form });
}

/** The select value that asks for a project with no issue yet. A real value always holds a newline between tool and project. */
export const newProject = 'new';

export type IssueView = {
  issue: Issue; comments: readonly Comment[]; claim: ClaimDisplay & { acquiredAt?: number };
  blockers: readonly { id: string; status: Status }[]; dependencyRevision: number;
  landOrder: { revision: number; after: readonly { id: string; status: Status }[]; before: readonly { id: string; status: Status }[] };
  parent: IssueLink | null; children: readonly IssueLink[]; moreChildren: boolean;
};

/** The issue page. `top` holds a conflict or a result above the title; `note` refills the decision note after a conflict. */
export function issuePage(view: IssueView, viewer: Viewer, counts: TabCounts, top = '', note = ''): string {
  const { issue } = view;
  const id = issue.id;
  const back = `/ui/i/${id}`;
  const closed = issue.status === 'closed';
  const decide = !closed && issue.labels.includes('owner-decision');
  const act = !closed && !decide && issue.labels.includes('owner-action');
  const active = view.blockers.filter(blocker => blockerIsActive(blocker.status));
  const done = view.blockers.filter(blocker => !blockerIsActive(blocker.status));
  const holder = view.claim.state === 'active' ? `held by ${holderName(viewer, view.claim)} until ${clockTime(view.claim.expiresAt)}` : null;
  const line = dispatchLine(issue, active.length, holder);
  const startable = line.endsWith('can start now');
  const write = canWrite(viewer);
  const text = title(issue.body);

  const cards: string[] = [];
  if (write && decide) {
    cards.push(`<section class="card themed l-you" id="decide"><h2>Your decision</h2><p class="hint">The note is saved as a comment. Approve clears owner-decision and adds ready. Decline closes it. Defer parks it and keeps the label.</p>${decideForm(issue, '/ui', viewer, true, note)}</section>`);
  }
  if (write && act) {
    cards.push(`<section class="card themed l-you" id="done"><h2>Your action</h2><p class="hint">Mark done saves your note as a comment and closes the issue. Not now parks it. Hand back to agents clears owner-action and adds ready.</p>${doneForm(issue, '/ui', true, note)}</section>`);
  }
  const rest = bodyAfterTitle(issue.body);
  const edit = write ? disclose('Edit text', 'edit', liveForm(`/ui/i/${id}/body`, { return: back, 'v.body': issue.versions.body },
    `<div class="field"><label for="eb">Issue text</label><textarea id="eb" name="body" rows="10">${escape(issue.body)}</textarea></div><button class="btn sm">Save text</button>`, false), true) : '';
  cards.push(`<section class="card" id="text"><h2>Text</h2><div class="prose"${lang(rest)}>${rest.trim() === '' ? '<span class="hint">No further text.</span>' : escape(rest)}</div>${edit === '' ? '' : `<div class="acts">${edit}</div>`}</section>`);

  const claimLine = view.claim.state === 'never_claimed' ? '<p>Not claimed.</p>'
    : `<div class="meta"><b>${escape(holderName(viewer, view.claim))}</b><span>${view.claim.state === 'active' ? 'holds this until' : view.claim.state === 'released' ? 'released it; the lease ran to' : 'held this until'} ${timeTag(view.claim.expiresAt, fullTime(view.claim.expiresAt))}</span></div>`
      + (view.claim.state === 'active' || view.claim.state === 'expired' ? leaseBar(view.claim.acquiredAt ?? view.claim.expiresAt, view.claim.expiresAt, viewer.now) : '');
  let agent = closed ? '<p class="hint">Closed. Reopen it to send it to an agent again.</p>' : `${claimLine}<p class="hint">${escape(line)}</p>`;
  if (!closed && canDispatch(viewer)) {
    const form = dispatchForm(issue, back, viewer, null, true);
    agent += startable || viewer.dispatch === 'unavailable' ? form : disclose('Dispatch anyway', 'send', form, true);
  }
  if (viewer.role === 'agent') agent += '<p class="hint">Signed in as an agent. Dispatch is not offered to agents.</p>';
  cards.push(`<section class="card l-agents" id="dispatch"><h2>Agent</h2>${agent}</section>`);

  const blockerItem = (blocker: { id: string; status: Status }, removable: boolean) => `<li>${idLink(blocker.id)}${statusChip(blocker.status)}`
    + `${removable && write ? disclose('Remove', 'x', unblockForm(id, blocker.id, view.dependencyRevision, back), true) : ''}</li>`;
  const blockerList = (active.length === 0 ? '<p>No active blockers.</p>' : `<ul class="mini" aria-label="Active blockers">${active.map(blocker => blockerItem(blocker, true)).join('')}</ul>`)
    + (done.length === 0 ? '' : `<p class="lbl">Closed blockers</p><ul class="mini">${done.map(blocker => blockerItem(blocker, false)).join('')}</ul>`);
  const addBlocker = write ? liveForm(`/ui/i/${id}/blockers/add`, { return: back, 'v.blockers': view.dependencyRevision },
    '<div class="field"><label for="ab">Wait on another issue</label><input id="ab" type="text" name="blocker" required placeholder="e.g. pd-65.3" autocapitalize="none" autocomplete="off" spellcheck="false"></div>'
    + `<button class="btn sm ghost">${icon('link', true)}Add blocker</button>`) : '';
  cards.push(`<section class="card l-stuck" id="blockers"><h2>Blockers</h2>${blockerList}${addBlocker}</section>`);

  if (view.parent !== null || view.children.length > 0) {
    const link = (entry: IssueLink) => `<li><a href="${escape(issueHref(entry.id))}">${mono(entry.id)}<span>${escape(shortTitle(entry.body, 60))}</span></a>${statusChip(entry.status)}</li>`;
    cards.push(`<section class="card" id="family"><h2>Family</h2>${view.parent === null ? '' : `<p class="lbl">Parent</p><ul class="mini">${link(view.parent)}</ul>`}`
      + (view.children.length === 0 ? '' : `<p class="lbl">Children</p><ul class="mini">${view.children.map(link).join('')}</ul>`)
      + (view.moreChildren ? `<p class="hint">The first ${view.children.length} children are shown.</p>` : '') + '</section>');
  }

  const comments = view.comments.map(comment => {
    const own = write && comment.created_by === viewer.actor.id;
    const editForm = own ? disclose('Edit', 'edit', liveForm(`/ui/i/${id}/comment-edit`, { return: back, comment: comment.id, 'v.comment': comment.version ?? 1 },
      `<div class="field"><label for="ce-${escape(comment.id)}">Comment</label><textarea id="ce-${escape(comment.id)}" name="body" rows="3">${escape(comment.body)}</textarea></div><button class="btn sm">Save comment</button>`, false), true) : '';
    const edited = typeof comment.updated_at === 'string' ? `<span>edited ${timeTag(secondsOf(comment.updated_at), fullTime(secondsOf(comment.updated_at)))}</span>` : '';
    // The persona and the stars are attribution; the bold name stays the actor that wrote the comment.
    const voice = (typeof comment.handle === 'string' ? `<span>as ${escape(comment.handle)}</span>` : '')
      + (comment.stars === undefined || comment.stars === 0 ? '' : `<span>${comment.stars} ${comment.stars === 1 ? 'star' : 'stars'}</span>`);
    return `<li class="l-${comment.created_by === viewer.actor.id ? 'you' : 'agents'}"><div class="by"><b>${escape(person(viewer, comment.created_by))}</b>`
      + `<span>${timeTag(secondsOf(comment.created_at), fullTime(secondsOf(comment.created_at)))}</span>${voice}${edited}</div><div class="prose"${lang(comment.body)}>${escape(comment.body)}</div>${editForm}</li>`;
  }).join('');
  cards.push(`<section class="card" id="comments"><h2>Comments <span class="count">${view.comments.length}</span></h2>${comments === '' ? '<p class="hint">No comments yet.</p>' : `<ol class="tl">${comments}</ol>`}`
    + `<div id="comment">${write ? commentForm(issue, back, true) : ''}</div></section>`);

  const aside: string[] = [];
  if (write) {
    const statuses = (['open', 'deferred', 'closed'] as const).map(status => issue.status === status
      ? `<button class="btn ghost" type="button" aria-pressed="true" disabled>${statusWord(status)}</button>`
      : `<button class="btn ghost" name="status" value="${status}" aria-pressed="false"${status === 'closed' ? ' data-confirm="Tap again to close"' : ''}>${statusWord(status)}</button>`).join('');
    const priorities = [0, 1, 2, 3, 4].map(priority => `<button class="btn ghost" name="priority" value="${priority}" aria-pressed="${issue.priority === priority}"${issue.priority === priority ? ' type="button" disabled' : ''}>P${priority}</button>`).join('');
    const types = ['bug', 'task', 'epic', 'feature', 'chore'].map(type => `<option${issue.type === type ? ' selected' : ''}>${type}</option>`).join('');
    const offered = [...issue.labels, ...workflowLabels.filter(label => !issue.labels.includes(label))];
    const toggles = offered.map(label => `<label class="tog"><input type="checkbox" name="labels" value="${escape(label)}"${issue.labels.includes(label) ? ' checked' : ''}><span>${escape(label)}</span></label>`).join('');
    aside.push(`<section class="card" id="change"><h2>Change</h2>`
      + liveForm(`/ui/i/${id}/status`, { return: back, 'v.status': issue.versions.status, 'seen.status': issue.status },
        `<div class="field"><span class="lbl">Status</span><div class="seg">${statuses}</div></div><p class="hint">In progress needs an agent’s claim, so agents set it.</p>`, false)
      + liveForm(`/ui/i/${id}/priority`, { return: back, 'v.priority': issue.versions.priority, 'seen.priority': issue.priority },
        `<div class="field"><span class="lbl">Priority</span><div class="seg p5">${priorities}</div></div>`, false)
      + liveForm(`/ui/i/${id}/type`, { return: back, 'v.type': issue.versions.type, 'seen.type': issue.type },
        `<div class="field"><label for="ty">Type</label><select id="ty" name="type">${types}</select></div><button class="btn sm ghost">Save type</button>`, false)
      + liveForm(`/ui/i/${id}/labels`, { return: back, 'v.labels': issue.versions.labels, 'seen.labels': JSON.stringify(issue.labels) },
        `<div class="field"><span class="lbl">Labels</span><div class="togs">${toggles}</div></div>`
        + '<div class="field"><label for="nl">Add labels, separated by spaces</label><input id="nl" type="text" name="labels.new" autocapitalize="none" autocomplete="off" spellcheck="false"></div>'
        + '<button class="btn sm">Save labels</button>', false) + '</section>');
  }
  if (issue.labels.includes('main-wait') || view.landOrder.after.length > 0) {
    const after = view.landOrder.after.map(entry => `<li>${idLink(entry.id)}${statusChip(entry.status)}${write ? liveForm(`/ui/i/${id}/land-order`, { return: back, op: 'clear', after: entry.id, 'v.land': view.landOrder.revision },
      '<button class="btn sm ghost" data-confirm="Tap again to clear">Clear</button>', false) : ''}</li>`).join('');
    const add = write ? liveForm(`/ui/i/${id}/land-order`, { return: back, op: 'set', 'v.land': view.landOrder.revision },
      '<div class="field"><label for="la">Lands after</label><input id="la" type="text" name="after" required placeholder="e.g. pd-65.3" autocapitalize="none" autocomplete="off" spellcheck="false"></div><button class="btn sm ghost">Set order</button>') : '';
    aside.push(`<section class="card l-land" id="land"><h2>Land order</h2>${after === '' ? '<p class="hint">No order set. It lands in queue order.</p>' : `<p class="lbl">Lands after</p><ul class="mini">${after}</ul>`}`
      + (view.landOrder.before.length === 0 ? '' : `<p class="hint">${view.landOrder.before.map(entry => idLink(entry.id)).join(', ')} ${view.landOrder.before.length === 1 ? 'lands' : 'land'} after this one.</p>`) + `${add}</section>`);
  }
  const created = secondsOf(issue.created_at);
  const updated = secondsOf(issue.updated_at);
  aside.push(`<section class="card" id="details"><h2>Details</h2><dl class="kv"><dt>Status</dt><dd>${statusChip(issue.status)}</dd><dt>Priority</dt><dd>P${issue.priority}</dd>`
    + `<dt>Type</dt><dd>${escape(issue.type)}</dd><dt>Tool</dt><dd>${escape(issue.tool)}</dd><dt>Project</dt><dd><a href="${escape(projectHref(issue.tool, issue.project))}">${escape(shortProject(issue.project))}</a></dd>`
    + `<dt>Created</dt><dd>${timeTag(created, fullTime(created))} by ${escape(person(viewer, issue.created_by))}</dd><dt>Updated</dt><dd>${timeTag(updated, fullTime(updated))} by ${escape(person(viewer, issue.updated_by))}</dd>`
    + (issue.closed_at != null ? `<dt>Closed</dt><dd>${escape(japanTime(issue.closed_at))}${issue.closed_by == null ? '' : ` by ${escape(person(viewer, issue.closed_by))}`}</dd>` : '') + '</dl></section>');

  let bar = '';
  if (write) {
    const buttons: string[] = [];
    if (closed) buttons.push(liveForm(`/ui/i/${id}/status`, { return: back, status: 'open', 'v.status': issue.versions.status, 'seen.status': issue.status }, `<button class="btn l-land">${icon('undo', true)}Reopen</button>`, false).replace(/<p class="live" role="status"><\/p>/, ''));
    else if (decide) buttons.push(`<a class="btn l-you grow" href="#decide">${icon('check', true)}Decide</a>`);
    else if (act) buttons.push(`<a class="btn l-you grow" href="#done">${icon('check', true)}Mark done</a>`);
    else if (startable && canDispatch(viewer)) buttons.push(`<a class="btn l-agents grow" href="#dispatch">${icon('send', true)}Dispatch</a>`);
    else if (active.length > 0) buttons.push(`<a class="btn l-stuck grow" href="#blockers">${icon('link', true)}Blockers</a>`);
    buttons.push(`<a class="btn ghost" href="#comment">${icon('comment', true)}Comment</a>`, `<a class="btn ghost" href="#change">${icon('sliders', true)}Change</a>`);
    bar = `<div class="bar" role="toolbar" aria-label="Actions for ${escape(id)}">${buttons.join('')}</div>`;
  }
  const role = viewer.role === 'reader' ? `<p class="role-note">${icon('lock', true)} Signed in as a reader. This page has no controls.</p>` : '';
  const since = decide || act ? `<p class="since l-you">${icon('clock')}On ${whose(viewer)} since ${timeTag(created, fullTime(created))} (${duration(viewer.now - created)})</p>` : '';
  const head = `<nav class="crumbs" aria-label="Breadcrumb"><a href="${escape(projectHref(issue.tool, issue.project))}">${icon('back', true)}${escape(shortProject(issue.project))}</a>`
    + `${view.parent === null ? '' : `<a href="${escape(issueHref(view.parent.id))}">${icon('link', true)}Parent ${escape(view.parent.id)}</a>`}</nav>`
    + `<h1 class="issue-title"${lang(text)}>${escape(text)}</h1><div class="chips">${statusChip(issue.status)}${priorityChip(issue.priority)}<span class="chip o">${escape(issue.type)}</span><span class="chip o mono">${escape(id)}</span></div>`
    + `<div class="chips" aria-label="Labels">${issue.labels.length === 0 ? '<span class="hint">No labels.</span>' : issue.labels.map(labelChip).join('')}</div>${since}`;
  return document({ title: `${id} ${shortTitle(issue.body, 40)}`, viewer, counts, bar: bar === '' ? undefined : bar,
    body: `${role}${top}${head}<div class="issue-grid"><div class="stack">${cards.join('')}</div><div class="stack">${aside.join('')}</div></div>` });
}

/** A short page for a result the fixed script did not show in place: a refusal, or a note that did not save. */
export function messagePage(heading: string, sentenceHtml: string, viewer: Viewer, counts: TabCounts, extra = ''): string {
  return document({ title: heading, viewer, counts, body: pageHead(heading) + `<p class="role-note" role="alert">${sentenceHtml}</p>${extra}` });
}

