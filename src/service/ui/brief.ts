/** The brief on Today: a headline, a sub line, and one sentence per lane, each composed by rule from the lanes. No model runs at request time. */
import type { ActivityCount, Issue } from '../../records/index.ts';
import { canDispatch, canWrite, dateLine, duration, escape, hidden, icon, idLink, joined, numberWord, person, plural, sentence, shortProject,
  shortTitle, clockTime, timeTag, whose, type Lane, type Viewer } from './html.ts';
import type { IconName } from './assets.ts';
import { holderName } from './rows.ts';
import type { Lanes } from './today.ts';

type Line = { lane: Lane; icon: IconName; name: string; text: string; action: string };

const quiet = (text: string): string => `<span class="quiet">${escape(text)}</span>`;
const linkButton = (label: string, href: string): string => `<a class="btn btn-h sm" href="${escape(href)}">${escape(label)}</a>`;

function youLine(lanes: Lanes, viewer: Viewer): Line {
  const lead = lanes.you.find(item => item.after.length === 0) ?? lanes.you[0];
  if (lead === undefined) {
    const text = viewer.role === 'human' ? 'Clear for now. Write a new issue, or dispatch a ready one.' : `Nothing waits on ${whose(viewer)}.`;
    return { lane: 'you', icon: 'you', name: 'You', text: quiet(text), action: canWrite(viewer) ? linkButton('New issue', '/ui/new') : linkButton('Projects', '/ui/projects') };
  }
  const what = { answer: 'a question', decide: 'a decision', do: 'an action' }[lead.kind];
  const waited = lead.waitedSeconds === null ? '' : ` It has waited ${duration(lead.waitedSeconds)}.`;
  const blocks = lead.blocks.length === 0 ? '' : ` ${lead.blocks.map(idLink).join(', ')} ${lead.blocks.length === 1 ? 'waits' : 'wait'} for it.`;
  const opener = viewer.role === 'human' ? 'Start with' : 'The first is';
  const text = `${opener} ${idLink(lead.issue.id)}, ${what} at P${lead.issue.priority}: ${escape(sentence(shortTitle(lead.issue.body)))}${waited}${blocks}`;
  const [label, anchor] = { answer: ['Answer', 'items'], decide: ['Decide', 'decide'], do: ['Open', 'done'] }[lead.kind];
  return { lane: 'you', icon: 'you', name: 'You', text, action: linkButton(label, `/ui/i/${lead.issue.id}#${anchor}`) };
}

function agentsLine(lanes: Lanes, viewer: Viewer): Line {
  const parts: string[] = [];
  for (const lock of lanes.locks) {
    parts.push(`${escape(holderName(viewer, lock))} holds the main lock for ${escape(shortProject(lock.issue.project))} until ${timeTag(lock.expiresAt, clockTime(lock.expiresAt))}, so a push to main is under way.`);
  }
  if (lanes.claims.length > 0) {
    const names = [...new Set(lanes.claims.map(claim => holderName(viewer, claim)))];
    const soonest = lanes.claims[0]!;
    parts.push(`${escape(joined(names))} ${plural(names.length, 'holds', 'hold')} ${lanes.claims.length} ${plural(lanes.claims.length, 'issue', 'issues')}. `
      + `The soonest lease ends in ${duration(soonest.expiresAt - viewer.now)} (${idLink(soonest.issue.id)}).`);
  }
  const ready = lanes.ready.length;
  if (ready > 0) parts.push(`${ready} ready ${plural(ready, 'issue has', 'issues have')} no agent.`);
  const text = parts.length === 0 ? quiet('No agent holds a claim, and no ready issue is waiting for one.') : parts.join(' ');
  let action = linkButton('Agents', '/ui/agents');
  if (ready > 0 && canDispatch(viewer) && viewer.dispatch === 'ready') {
    const only = lanes.ready[0]!;
    // One ready issue: the button is the dispatch itself, behind a second tap. More: it opens the ready list.
    action = ready === 1
      ? `<form method="post" action="/ui/i/${escape(only.id)}/dispatch" data-live>${hidden({ return: '/ui' })}<button class="btn btn-h sm" data-confirm="Tap again to dispatch">Dispatch 1</button><p class="live" role="status"></p></form>`
      : linkButton(`Dispatch ${ready}`, '/ui/agents#ready');
  }
  return { lane: 'agents', icon: 'agents', name: 'Agents', text, action };
}

function landingLine(lanes: Lanes): Line {
  const count = lanes.queue.length;
  const first = lanes.queue[0];
  const text = first === undefined ? quiet('Nothing waits on queue for main.')
    : `${count} ${plural(count, 'issue is', 'issues are')} on queue and not on main. ${idLink(first.issue.id)} lands first. Landing needs a push from your machine.`;
  return { lane: 'land', icon: 'land', name: 'Landing', text, action: linkButton('Queue', '/ui/landing') };
}

function stuckLine(lanes: Lanes, viewer: Viewer): Line {
  const parts: string[] = [];
  const first = lanes.expired[0];
  if (first !== undefined && first.claim.state === 'expired') {
    parts.push(lanes.expired.length === 1
      ? `${escape(holderName(viewer, first.claim))}’s claim on ${idLink(first.issue.id)} expired ${duration(viewer.now - first.claim.expiresAt)} ago.`
      : `${lanes.expired.length} claims expired.`);
  }
  if (lanes.blockedTotal > 0) parts.push(`${lanes.blockedTotal} ${plural(lanes.blockedTotal, 'issue waits', 'issues wait')} on a blocker.`);
  if (lanes.staleTotal > 0) parts.push(`${lanes.staleTotal} started ${plural(lanes.staleTotal, 'issue has', 'issues have')} no live claim.`);
  return { lane: 'stuck', icon: 'stuck', name: 'Stuck', text: parts.length === 0 ? quiet('Nothing looks stuck.') : parts.join(' '), action: linkButton('Review', '/ui/stuck') };
}

export function hero(lanes: Lanes, viewer: Viewer): string {
  const count = lanes.you.length;
  const heading = count === 0 ? `Nothing waits on ${whose(viewer)}.`
    : `${numberWord(count)} ${plural(count, 'thing waits', 'things wait')} on ${whose(viewer)}.`;
  const parts = [...(lanes.answer > 0 ? [`${lanes.answer} to answer`] : []), ...(lanes.decide > 0 ? [`${lanes.decide} to decide`] : []), ...(lanes.todo > 0 ? [`${lanes.todo} to do`] : [])];
  const oldest = Math.max(-1, ...lanes.you.map(item => item.waitedSeconds ?? -1));
  const sub = count === 0 ? '' : `<p class="sub">${parts.join(', ')}${oldest < 0 ? '' : `; the oldest has waited ${duration(oldest)}`}.</p>`;
  const lines = [youLine(lanes, viewer), agentsLine(lanes, viewer), landingLine(lanes), stuckLine(lanes, viewer)]
    .map(line => `<li class="l-${line.lane}"><p class="tag">${icon(line.icon)}${line.name}</p>${line.action}<p class="bt">${line.text}</p></li>`).join('');
  return `<section class="hero" aria-labelledby="brief-h"><p class="eyebrow">${timeTag(viewer.now, dateLine(viewer.now))}</p>`
    + `<h1 id="brief-h">${escape(heading)}</h1>${sub}<ol class="brief">${lines}</ol></section>`;
}

const nouns: Record<string, readonly [string, string]> = {
  created: ['new issue', 'new issues'], updated: ['update', 'updates'], status_changed: ['status change', 'status changes'],
  commented: ['comment', 'comments'], comment_edited: ['comment edit', 'comment edits'], claim_acquired: ['claim', 'claims'],
  claim_released: ['release', 'releases'], dependency_added: ['added blocker or land order', 'added blockers or land orders'],
  dependency_removed: ['removed blocker or land order', 'removed blockers or land orders'], became_ready: ['issue became ready', 'issues became ready'],
  starred: ['star', 'stars'], unstarred: ['removed star', 'removed stars'],
};

/** "Since 09:12 yesterday: 14 changes. Claude made 9: 5 updates and 4 comments." */
export function sinceYesterday(counts: readonly ActivityCount[], viewer: Viewer): string {
  const from = timeTag(viewer.now - 86400, clockTime(viewer.now - 86400));
  const total = counts.reduce((sum, row) => sum + row.events, 0);
  if (total === 0) return `Since ${from} yesterday, nothing changed.`;
  const actors = new Map<string, ActivityCount[]>();
  for (const row of counts) actors.set(row.actor, [...(actors.get(row.actor) ?? []), row]);
  const said = [...actors].map(([actor, rows]) => {
    const made = rows.reduce((sum, row) => sum + row.events, 0);
    const kinds = rows.map(row => { const [one, many] = nouns[row.kind] ?? [row.kind, row.kind]; return `${row.events} ${plural(row.events, one, many)}`; });
    return `${escape(person(viewer, actor))} made ${made}: ${escape(joined(kinds))}.`;
  });
  return `Since ${from} yesterday: ${total} ${plural(total, 'change', 'changes')}. ${said.join(' ')}`;
}

/** The kinds a write handler may name in ?done=, with the sentence each one starts with. */
export const doneKinds = {
  approved: (id: string) => `Decision recorded on ${id}. Approved: owner-decision cleared and ready added.`,
  declined: (id: string) => `Decision recorded on ${id}. Declined and closed.`,
  deferred: (id: string) => `${id} is deferred. It leaves You until it is reopened.`,
  done: (id: string) => `${id} is marked done and closed.`,
  answered: (id: string) => `Answer recorded on ${id}. The agent that asked sees it in the change feed.`,
  waived: (id: string) => `Check waived on ${id}. The reason is on the item.`,
  handedback: (id: string) => `${id} is back with the agents, labeled ready.`,
  dispatched: (id: string) => `Dispatch sent for ${id}.`,
  opened: (id: string) => `${id} is open again.`,
  closed: (id: string) => `${id} is closed.`,
  created: (id: string) => `${id} is created.`,
} as const;
export type DoneKind = keyof typeof doneKinds;
export const isDoneKind = (value: string): value is DoneKind => Object.hasOwn(doneKinds, value);

/** The flash after a write: what happened, a way back for a close, and the next You item. Composed from the code and the store, never from posted text. */
export function flash(kind: DoneKind, issue: Issue | null, id: string, lanes: Lanes, viewer: Viewer): string {
  const reopen = issue !== null && issue.status === 'closed' && canWrite(viewer)
    ? `<form method="post" action="/ui/i/${escape(id)}/status">${hidden({ return: '/ui', status: 'open', 'v.status': issue.versions.status, 'seen.status': 'closed' })}<button class="btn sm ghost">${icon('undo', true)}Reopen</button></form>` : '';
  const next = lanes.you.find(item => item.issue.id !== id);
  const after = next === undefined ? ` Nothing else waits on ${whose(viewer)}.` : ` Next: ${idLink(next.issue.id)}, ${escape(sentence(shortTitle(next.issue.body, 40)))}`;
  const where = kind === 'approved' && issue?.labels.includes('ready') ? ' It now shows under Agents as ready.' : '';
  return `<div class="flash l-land" role="status">${icon('check')}<div><p>${escape(doneKinds[kind](id))}${where} <a href="/ui/i/${escape(id)}">Open it</a>.${after}</p>${reopen}</div></div>`;
}

