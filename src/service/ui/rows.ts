/** Lane rows and the inline forms they carry. Each form posts to a /ui write route with the field versions it observed. */
import { ownerWaitLabels, readyLabel, type ActiveClaimIssue, type BlockedIssue, type ClaimDisplay, type Issue, type StartedIssue } from '../../records/index.ts';
import { canDispatch, canWrite, clockTime, disclose, duration, escape, fullTime, icon, idLink, issueHref, lang, liveForm, mono,
  person, priorityChip, secondsOf, shortProject, statusChip, timeTag, title, workflowChips, type Lane, type Viewer } from './html.ts';
import type { QueueItem, YouItem } from './today.ts';

const seenLabels = (issue: Issue): string => JSON.stringify(issue.labels);

export function decideForm(issue: Issue, back: string, viewer: Viewer, big = false, note = ''): string {
  const size = big ? '' : ' sm';
  const send = canDispatch(viewer) && viewer.dispatch === 'ready'
    ? '<label class="check"><input type="checkbox" name="dispatch" value="1"> Send to an agent after approving</label>' : '';
  const field = `dn-${issue.id}${big ? '-main' : ''}`;
  return liveForm(`/ui/i/${issue.id}/decide`, { return: back, 'v.labels': issue.versions.labels, 'v.status': issue.versions.status, 'seen.labels': seenLabels(issue), 'seen.status': issue.status },
    `<div class="field"><label for="${field}">Decision note</label><textarea id="${field}" name="note" rows="3" placeholder="Optional. Why, or a condition.">${escape(note)}</textarea></div>${send}`
    + `<div class="btn-row"><button class="btn${size}" name="outcome" value="approve">Approve</button>`
    + `<button class="btn${size} ghost" name="outcome" value="decline">Decline</button>`
    + `<button class="btn${size} ghost" name="outcome" value="defer">Defer</button></div>`);
}

export function doneForm(issue: Issue, back: string, big = false, note = ''): string {
  const size = big ? '' : ' sm';
  const field = `do-${issue.id}${big ? '-main' : ''}`;
  return liveForm(`/ui/i/${issue.id}/done`, { return: back, 'v.labels': issue.versions.labels, 'v.status': issue.versions.status, 'seen.labels': seenLabels(issue), 'seen.status': issue.status },
    `<div class="field"><label for="${field}">What you did (optional)</label><textarea id="${field}" name="note" rows="3" placeholder="Result and time, if useful.">${escape(note)}</textarea></div>`
    + `<div class="btn-row"><button class="btn${size}" name="outcome" value="done">Mark done</button>`
    + `<button class="btn${size} ghost" name="outcome" value="defer">Not now</button>`
    + `<button class="btn${size} ghost" name="outcome" value="handback">Hand back to agents</button></div>`);
}

/** Whether the ready worklist would offer the issue to an agent now. It informs only; the dispatcher decides. */
export function dispatchLine(issue: Issue, activeBlockers: number, holder: string | null): string {
  const ownerWait = ownerWaitLabels.find(label => issue.labels.includes(label));
  const ready = issue.labels.includes(readyLabel);
  const locked = issue.labels.includes('main-lock');
  const parts = [
    ...(ownerWait === undefined ? [] : [`${ownerWait}, not agent work`]),
    ...(issue.status === 'open' ? [] : [issue.status]),
    ready ? 'ready' : 'not ready',
    ...(locked ? ['main-lock'] : []),
    activeBlockers === 0 ? 'no blockers' : `${activeBlockers} active ${activeBlockers === 1 ? 'blocker' : 'blockers'}`,
    holder ?? 'not claimed',
  ];
  const startable = ready && issue.status === 'open' && !locked && ownerWait === undefined && activeBlockers === 0 && holder === null;
  return [...parts, startable ? 'can start now' : 'will not start now'].join(' · ');
}

export function dispatchForm(issue: Issue, back: string, viewer: Viewer, line: string | null, big = false): string {
  if (!canDispatch(viewer)) return '';
  const size = big ? '' : ' sm';
  const hint = line === null ? '' : `<p class="hint">${escape(line)}</p>`;
  if (viewer.dispatch === 'unavailable') {
    return `<button class="btn${size}" type="button" disabled>${icon('send', true)}Dispatch</button><p class="hint">Dispatch is not set up.</p>${hint}`;
  }
  const field = `dp-${issue.id}${big ? '-main' : ''}`;
  return liveForm(`/ui/i/${issue.id}/dispatch`, { return: back },
    `<div class="field"><label for="${field}">Notes for the agent</label><textarea id="${field}" name="notes" rows="3" maxlength="4096" placeholder="Optional. Up to 4096 characters."></textarea></div>`
    + `<button class="btn${size}">${icon('send', true)}Dispatch</button>${hint}`);
}

export function commentForm(issue: Issue, back: string, big = false): string {
  const field = `cm-${issue.id}${big ? '-main' : ''}`;
  return liveForm(`/ui/i/${issue.id}/comment`, { return: back },
    `<div class="field"><label for="${field}">Comment</label><textarea id="${field}" name="body" rows="3" required></textarea></div><button class="btn${big ? '' : ' sm'}">Send comment</button>`);
}

/** One status button. A move to closed, or out of in_progress, asks for a second tap. */
export function statusForm(issue: Issue, back: string, status: 'open' | 'deferred' | 'closed', label: string, ghost = true): string {
  const confirm = status === 'closed' ? ' data-confirm="Tap again to close"' : issue.status === 'in_progress' ? ' data-confirm="Tap again to set open"' : '';
  return liveForm(`/ui/i/${issue.id}/status`, { return: back, 'v.status': issue.versions.status, 'seen.status': issue.status },
    `<button class="btn sm${ghost ? ' ghost' : ''}" name="status" value="${status}"${confirm}>${icon(status === 'closed' ? 'check' : 'undo', true)}${escape(label)}</button>`, false);
}

export function unblockForm(dependent: string, blocker: string, revision: number, back: string): string {
  return liveForm(`/ui/i/${dependent}/blockers/remove`, { return: back, blocker, 'v.blockers': revision },
    `<p class="hint">Remove ${escape(blocker)} as a blocker of ${escape(dependent)}? It is offered to agents once nothing else blocks it.</p>`
    + '<button class="btn sm ghost danger" data-confirm="Tap again to remove">Remove blocker</button>', false);
}

export function leaseBar(acquiredAt: number, expiresAt: number, now: number): string {
  if (expiresAt <= now) {
    return `<div class="lease gone"><p>${icon('warn', true)}<b>Expired ${timeTag(expiresAt, clockTime(expiresAt))}</b><span>${duration(now - expiresAt)} ago</span></p>`
      + '<progress max="100" value="100" aria-label="Lease used up"></progress></div>';
  }
  const used = Math.max(0, Math.min(100, Math.round(100 * (now - acquiredAt) / Math.max(1, expiresAt - acquiredAt))));
  const warn = expiresAt - now < 900;
  return `<div class="lease${warn ? ' warn' : ''}"><p>${icon(warn ? 'warn' : 'clock', true)}<b>Ends ${timeTag(expiresAt, clockTime(expiresAt))}</b><span>in ${duration(expiresAt - now)}</span></p>`
    + `<progress max="100" value="${used}" aria-label="Lease ${used} percent used"></progress></div>`;
}

const dot = (name: string): string => `<span class="who-dot" aria-hidden="true">${escape(Array.from(name)[0]?.toUpperCase() ?? '?')}</span>`;
export const holderName = (viewer: Viewer, claim: { agentLabel: string | null; actor: string }): string => claim.agentLabel ?? person(viewer, claim.actor);

function row(issue: Issue, lane: Lane | null, meta: string, actions = '', extra = ''): string {
  const text = title(issue.body);
  return `<li class="row${lane === null ? '' : ` l-${lane}`}" data-row><div class="meta">${meta}</div>`
    + `<a class="title"${lang(text)} href="${escape(issueHref(issue.id))}">${escape(text)}</a>${extra}${actions === '' ? '' : `<div class="acts">${actions}</div>`}</li>`;
}

export function youRow(item: YouItem, viewer: Viewer, back = '/ui'): string {
  const decide = item.kind === 'decide';
  const waited = item.waitedSeconds === null ? '' : `<span>waiting ${duration(item.waitedSeconds)}</span>`;
  const meta = `<span class="chip c l-you">${decide ? 'Decide' : 'Do'}</span>${mono(item.issue.id)}${priorityChip(item.issue.priority)}${waited}`;
  const after = item.after.length === 0 ? '' : `<p class="sub-line">${icon('link', true)} Starts after ${item.after.map(idLink).join(', ')} ${item.after.length === 1 ? 'is' : 'are'} done.</p>`;
  const blocks = item.blocks.length === 0 ? '' : `<p class="sub-line">${item.blocks.map(idLink).join(', ')} ${item.blocks.length === 1 ? 'waits' : 'wait'} for it.</p>`;
  const actions = !canWrite(viewer) ? '' : decide ? disclose('Decide', 'check', decideForm(item.issue, back, viewer)) : disclose('Mark done', 'check', doneForm(item.issue, back));
  return row(item.issue, 'you', meta, actions, after + blocks);
}

export function claimRow(claim: ActiveClaimIssue, viewer: Viewer, back: string, comment = true): string {
  const name = holderName(viewer, claim);
  const meta = `${dot(name)}<b>${escape(name)}</b>${mono(claim.issue.id)}${priorityChip(claim.issue.priority)}<span>${escape(shortProject(claim.issue.project))}</span>`;
  const note = claim.lastNote === null ? '' : `<p class="quote"${lang(claim.lastNote.body)}><b>${timeTag(secondsOf(claim.lastNote.at), clockTime(secondsOf(claim.lastNote.at)))}</b> “${escape(claim.lastNote.body.replace(/\s+/g, ' ').trim())}”</p>`;
  const actions = comment && canWrite(viewer) ? disclose('Comment', 'comment', commentForm(claim.issue, back), true) : '';
  return row(claim.issue, 'agents', meta, actions, leaseBar(claim.acquiredAt, claim.expiresAt, viewer.now) + note);
}

export function readyRow(issue: Issue, viewer: Viewer, back: string): string {
  const meta = `<span class="chip c l-agents">ready</span>${mono(issue.id)}${priorityChip(issue.priority)}<span>${escape(shortProject(issue.project))}</span>`;
  const actions = canDispatch(viewer) ? disclose('Dispatch', 'send', dispatchForm(issue, back, viewer, dispatchLine(issue, 0, null))) : '';
  return row(issue, 'agents', meta, actions, '<p class="sub-line">No agent holds it.</p>');
}

export function queueRow(item: QueueItem, actions = ''): string {
  const after = item.after.length === 0 ? '<span>no order set</span>' : `<span>after ${item.after.map(idLink).join(', ')}</span>`;
  const next = item.position === 1 ? '<span class="chip c l-land">Lands next</span>' : '';
  const text = title(item.issue.body);
  return `<li class="row l-land has-num" data-row><span class="num" aria-label="Position ${item.position}">${item.position}</span><div>`
    + `<div class="meta">${next}${mono(item.issue.id)}${priorityChip(item.issue.priority)}<span>${escape(shortProject(item.issue.project))}</span>${after}</div>`
    + `<a class="title"${lang(text)} href="${escape(issueHref(item.issue.id))}">${escape(text)}</a>${actions === '' ? '' : `<div class="acts">${actions}</div>`}</div></li>`;
}

export function expiredRow(started: StartedIssue, viewer: Viewer, back: string): string {
  const claim = started.claim as Exclude<ClaimDisplay, { state: 'never_claimed' }>;
  const name = holderName(viewer, claim);
  const meta = `<span class="chip c l-stuck">Claim expired</span>${dot(name)}<b>${escape(name)}</b>${mono(started.issue.id)}${priorityChip(started.issue.priority)}`;
  const actions = !canWrite(viewer) ? '' : statusForm(started.issue, back, 'open', 'Set to open')
    + (canDispatch(viewer) ? disclose('Dispatch again', 'send', dispatchForm(started.issue, back, viewer, null)) : '');
  return row(started.issue, 'stuck', meta, actions, leaseBar(claim.expiresAt, claim.expiresAt, viewer.now));
}

export function blockedRow(blocked: BlockedIssue, viewer: Viewer, back: string): string {
  const meta = `<span class="chip c l-stuck">${icon('link')}Waits on ${blocked.openBlockers}</span>${mono(blocked.issue.id)}${priorityChip(blocked.issue.priority)}<span>${escape(shortProject(blocked.issue.project))}</span>`;
  const list = `<ul class="mini" aria-label="Active blockers">${blocked.blockerIds.map(id => `<li>${icon('link', true)}${idLink(id)}</li>`).join('')}</ul>`;
  const actions = canWrite(viewer) ? disclose('Remove blocker', 'x', blocked.blockerIds.map(id => unblockForm(blocked.issue.id, id, blocked.dependencyRevision, back)).join('')) : '';
  return row(blocked.issue, 'stuck', meta, actions, list);
}

/** A row for lists that only link: projects, search, stale issues. */
export function plainRow(issue: Issue, viewer: Viewer, extra = '', showProject = false): string {
  const bits = `${mono(issue.id)}${statusChip(issue.status)}${priorityChip(issue.priority)}<span>${escape(issue.type)}</span>${showProject ? `<span>${escape(shortProject(issue.project))}</span>` : ''}${workflowChips(issue)}`;
  const updated = `<div class="meta"><span>updated ${timeTag(secondsOf(issue.updated_at), fullTime(secondsOf(issue.updated_at)))} by ${escape(person(viewer, issue.updated_by))}</span></div>`;
  return row(issue, null, bits, '', extra + updated);
}
