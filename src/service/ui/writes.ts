/**
 * The /ui write handlers. Each one reads a urlencoded form, checks the role, writes through executeOperation with the field versions the
 * form observed, and answers a 303 to a /ui path, JSON for the fixed script, or a full page: 409 with a diff when a version is stale.
 * The update goes first and the note second, so a note never claims a change that did not happen. Origin checks belong to the entry module.
 */
import { executeOperation, parseIssueId, parseOperation, projectSummaries, PolylinedbError, type ClaimInspection, type Issue, type ItemResolve, type Status } from '../../records/index.ts';
import type { SqlExecutor } from '../../records/persistence/persistence.ts';
import type { DispatchOutcome } from '../dispatch.ts';
import { escape, fullTime, hidden, icon, idLink, joined, person, secondsOf, shortTitle, statusWord, type Viewer } from './html.ts';
import { doneKinds, type DoneKind } from './brief.ts';
import { issuePage, messagePage, newPage, newProject, tabCounts, type FreshProject } from './pages.ts';
import { readIssueView } from './reads.ts';
import { composeLanes, readBadgeLanes } from './today.ts';

export const issueActions = ['decide', 'done', 'item', 'dispatch', 'comment', 'comment-edit', 'star', 'status', 'priority', 'type', 'labels', 'body',
  'blockers/add', 'blockers/remove', 'land-order'] as const;
export type IssueAction = typeof issueActions[number];
export type WriteRoute = { kind: 'issue'; id: string; action: IssueAction } | { kind: 'new' } | { kind: 'landed' };
export type WriteContext = {
  db: SqlExecutor;
  viewer: Viewer;
  /** Presses Dispatch for one issue. The dispatcher owns the decision and the send. */
  dispatch: (id: string, form: URLSearchParams | 'invalid') => Promise<DispatchOutcome>;
};
export type WriteAnswer = { status: number; location?: string; json?: { ok: boolean; message: string }; html?: string };

const types = ['bug', 'task', 'epic', 'feature', 'chore'] as const;
const newLabels = ['ready', 'owner-decision', 'owner-action'] as const;
// The shortest lease the store allows. It exists only for one status write by a person, and is released right after it.
const ownerLeaseSeconds = 30;

/** A refusal: nothing was written, or the part named in the sentence was not. */
class Refusal extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** A stale version. `rows` is the four-row diff; `form` is the resubmit form with the current versions. */
type Conflict = { rows: { saw: string; now: string; change: string; result: string }; by: string; again: [string, string][]; outcome: string; note: string };
class Stale extends Error {
  conflict: Conflict;
  constructor(conflict: Conflict) { super('stale'); this.conflict = conflict; }
}

/** A /ui path only: no scheme, no host, no protocol-relative path, no backslash, and no control character. */
export function returnPath(value: string | null, fallback: string): string {
  if (value === null || value.length > 512) return fallback;
  if (!/^\/ui(?:[/?#]|$)/.test(value) || value.includes('//') || value.includes('\\') || /\p{Cc}/u.test(value)) return fallback;
  return value;
}

function withDone(path: string, kind: DoneKind, id: string): string {
  const hash = path.indexOf('#');
  const base = hash < 0 ? path : path.slice(0, hash);
  const clean = base.replace(/([?&])done=[^&]*&?/, '$1').replace(/[?&]$/, '');
  return `${clean}${clean.includes('?') ? '&' : '?'}done=${kind}:${encodeURIComponent(id)}${hash < 0 ? '' : path.slice(hash)}`;
}

const one = (form: URLSearchParams, name: string): string | null => {
  const values = form.getAll(name);
  if (values.length > 1) throw new Refusal(400, `The form sent ${name} twice. Reload the page and try again.`);
  return values[0] ?? null;
};
const required = (form: URLSearchParams, name: string, what: string): string => {
  const value = one(form, name);
  if (value === null || value.trim() === '') throw new Refusal(400, `${what} is empty. Nothing changed.`);
  return value;
};
function version(form: URLSearchParams, name: string): number {
  const value = one(form, name);
  if (value === null || !/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Refusal(400, 'The form has no field version. Reload the page and try again.');
  return Number(value);
}
function seenLabels(form: URLSearchParams): string[] {
  const value = one(form, 'seen.labels');
  if (value === null) throw new Refusal(400, 'The form has no label list. Reload the page and try again.');
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every(label => typeof label === 'string')) return parsed as string[];
  } catch { /* falls through to the refusal */ }
  throw new Refusal(400, 'The form label list is not valid. Reload the page and try again.');
}
function issueId(value: string, what: string): string {
  try { return parseIssueId(value.trim()); } catch { throw new Refusal(400, `${what} “${value.trim().slice(0, 40)}” is not an issue id, such as pd-65.`); }
}

const run = (ctx: WriteContext, input: Record<string, unknown>) => executeOperation(ctx.db, parseOperation(input), ctx.viewer.actor);

async function current(ctx: WriteContext, id: string): Promise<{ issue: Issue; claim: ClaimInspection }> {
  const shown = await run(ctx, { op: 'show', id });
  if (!('comments' in shown)) throw new PolylinedbError('storage_error', 'Issue is unavailable', 500);
  return { issue: shown.issue, claim: shown.claim };
}

const labelText = (labels: readonly string[]): string => labels.length === 0 ? 'no labels' : labels.join(', ');
type Field = 'status' | 'priority' | 'type' | 'labels' | 'body';
function shown(field: Field, value: unknown): string {
  if (field === 'status') return statusWord(value as Status);
  if (field === 'priority') return `P${String(value)}`;
  if (field === 'labels') return labelText(value as string[]);
  if (field === 'body') return `“${shortTitle(String(value), 60)}”`;
  return String(value);
}
const by = (viewer: Viewer, issue: Issue): string => `The last change was by ${person(viewer, issue.updated_by)} at ${fullTime(secondsOf(issue.updated_at))}.`;

/** Applies `remove` and `add` to `labels`, keeping order and dropping duplicates. */
function relabel(labels: readonly string[], remove: readonly string[], add: readonly string[]): string[] {
  return [...new Set([...labels.filter(label => !remove.includes(label)), ...add])];
}

/**
 * The store compares the whole label list by one version. A stale list still merges when the concurrent change touched none of the labels
 * this change adds or removes; then the change applies to the current list under the current version. Otherwise it is a conflict.
 */
function labelPlan(seen: readonly string[], desired: readonly string[], now: readonly string[]): string[] | null {
  const touched = [...desired.filter(label => !seen.includes(label)), ...seen.filter(label => !desired.includes(label))];
  if (touched.some(label => seen.includes(label) !== now.includes(label))) return null;
  return relabel(now, seen.filter(label => !desired.includes(label)), desired.filter(label => !seen.includes(label)));
}

type Change = { field: Field; value: unknown; expected: number };

/**
 * One guarded update. A status change on an issue that was ever claimed needs a claim proof, even for a person, so the handler takes a
 * 30-second lease of its own, writes under it, and releases it. A live claim of someone else is a refusal, never something to take over.
 */
async function update(ctx: WriteContext, now: { issue: Issue; claim: ClaimInspection }, changes: readonly Change[]): Promise<Issue> {
  const id = now.issue.id;
  const lease = changes.some(change => change.field === 'status') && ctx.viewer.actor.kind === 'human' && now.claim.state !== 'never_claimed';
  if (!lease) return issueOf(await run(ctx, { op: 'update', id, changes }));
  if (now.claim.state === 'active' && now.claim.lease !== null) {
    const holder = now.claim.lease.agent_label ?? person(ctx.viewer, now.claim.lease.actor);
    throw new Refusal(409, `${holder} holds a claim on ${id} until ${fullTime(now.claim.lease.expires_at)}. Change its status after the claim ends, or ask the holder. Nothing changed.`);
  }
  const acquired = await run(ctx, { op: 'claim_acquire', issue_id: id, incarnation: now.claim.store_incarnation, session_id: crypto.randomUUID(),
    request_id: crypto.randomUUID(), ttl: ownerLeaseSeconds, agent_label: 'pd ui' });
  if (!('claim_receipt' in acquired)) throw new PolylinedbError('storage_error', 'Claim receipt is unavailable', 500);
  const receipt = acquired.claim_receipt;
  const claim_proof = { issue_id: id, incarnation: receipt.incarnation, session_id: receipt.session_id, generation: receipt.generation };
  try {
    return issueOf(await run(ctx, { op: 'update', id, changes, claim_proof }));
  } finally {
    // A failed release leaves a lease that ends by itself in 30 seconds; the write it guarded already stands or already failed.
    await run(ctx, { op: 'claim_release', claim_proof, expected_revision: receipt.revision, request_id: crypto.randomUUID(), expired_noop: true }).catch(() => undefined);
  }
}
function issueOf(result: unknown): Issue {
  if (typeof result === 'object' && result !== null && 'issue' in result) return (result as { issue: Issue }).issue;
  throw new PolylinedbError('storage_error', 'Updated issue is unavailable', 500);
}

/** Scalar fields: a stale version is a conflict, shown with what the person saw, what is there now, and the change they asked for. */
function scalarCheck(viewer: Viewer, form: URLSearchParams, issue: Issue, field: Exclude<Field, 'labels'>, value: unknown, outcome: string, note = ''): Change {
  const expected = version(form, `v.${field}`);
  if (expected !== issue.versions[field]) {
    const seen = one(form, `seen.${field}`);
    throw new Stale({ rows: { saw: field === 'body' ? 'An earlier version of the text.' : seen === null ? 'An earlier version.' : shown(field, field === 'priority' ? Number(seen) : seen),
      now: shown(field, issue[field]), change: shown(field, value), result: field === 'body' ? 'Your text replaces the current text.' : `${shown(field, value)}.` },
      by: by(viewer, issue), again: refreshed(form, issue), outcome, note });
  }
  return { field, value, expected };
}
function labelCheck(viewer: Viewer, form: URLSearchParams, issue: Issue, desired: readonly string[], outcome: string, note = ''): Change {
  const expected = version(form, 'v.labels');
  const seen = seenLabels(form);
  if (expected === issue.versions.labels) return { field: 'labels', value: [...desired], expected };
  const merged = labelPlan(seen, desired, issue.labels);
  if (merged !== null) return { field: 'labels', value: merged, expected: issue.versions.labels };
  const added = desired.filter(label => !seen.includes(label));
  const removed = seen.filter(label => !desired.includes(label));
  const change = [...added.map(label => `add ${label}`), ...removed.map(label => `remove ${label}`)];
  throw new Stale({ rows: { saw: labelText(seen), now: labelText(issue.labels), change: change.length === 0 ? 'no label change' : joined(change),
    result: `${labelText(relabel(issue.labels, removed, added))}.` }, by: by(viewer, issue), again: refreshed(form, issue), outcome, note });
}
/** The posted fields with every version and every seen value replaced by the current ones, for "apply on the current version". The note is a field of its own. */
function refreshed(form: URLSearchParams, issue: Issue): [string, string][] {
  return [...form].filter(([name]) => name !== 'note').map(([name, value]): [string, string] => {
    if (name.startsWith('v.') && Object.hasOwn(issue.versions, name.slice(2))) return [name, String(issue.versions[name.slice(2) as Field])];
    if (name === 'seen.labels') return [name, JSON.stringify(issue.labels)];
    if (name.startsWith('seen.') && Object.hasOwn(issue.versions, name.slice(5))) return [name, String(issue[name.slice(5) as Field])];
    return [name, value];
  });
}
/** The posted fields with one version replaced. */
const replaced = (form: URLSearchParams, name: string, value: string): [string, string][] =>
  [...form].map(([key, old]): [string, string] => [key, key === name ? value : old]);

async function comment(ctx: WriteContext, id: string, body: string): Promise<void> {
  await run(ctx, { op: 'comment', id, body });
}

/** Saves the note after the update. When the note fails, the update still stands, and the answer says so and keeps the note. */
async function noteAfter(ctx: WriteContext, id: string, note: string, saved: string): Promise<string | null> {
  if (note.trim() === '') return null;
  try { await comment(ctx, id, note); return null; }
  catch (error) { return `${saved} The note was not saved: ${error instanceof PolylinedbError ? error.message : 'the store did not answer'}. Your note is below; send it as a comment.`; }
}

type Done = { kind: 'done'; done: DoneKind; id: string; message: string; dispatched?: DispatchOutcome } | { kind: 'saved'; id: string; message: string; hash?: string }
  | { kind: 'partial'; id: string; message: string; note: string };

const decisions = { approve: 'Approve', decline: 'Decline', defer: 'Defer' } as const;
const decided = { approve: 'Approved.', decline: 'Declined.', defer: 'Deferred.' } as const;
const actions = { done: 'Mark done', defer: 'Not now', handback: 'Hand back to agents' } as const;

async function decide(ctx: WriteContext, id: string, form: URLSearchParams): Promise<Done> {
  const outcome = one(form, 'outcome');
  if (outcome !== 'approve' && outcome !== 'decline' && outcome !== 'defer') throw new Refusal(400, 'Choose Approve, Decline, or Defer. Nothing changed.');
  const note = one(form, 'note') ?? '';
  const now = await current(ctx, id);
  const label = `${decisions[outcome]} on the current version`;
  const change = outcome === 'approve'
    ? labelCheck(ctx.viewer, form, now.issue, relabel(seenLabels(form), ['owner-decision'], ['ready']), label, note)
    : scalarCheck(ctx.viewer, form, now.issue, 'status', outcome === 'decline' ? 'closed' : 'deferred', label, note);
  await update(ctx, now, [change]);
  const done: DoneKind = outcome === 'approve' ? 'approved' : outcome === 'decline' ? 'declined' : 'deferred';
  // The comment names the outcome, so the history reads without the label change beside it.
  const partial = await noteAfter(ctx, id, note.trim() === '' ? '' : `${decided[outcome]} ${note}`, doneKinds[done](id));
  if (partial !== null) return { kind: 'partial', id, message: partial, note };
  const dispatched = outcome === 'approve' && one(form, 'dispatch') === '1' && ctx.viewer.dispatch === 'ready' ? await ctx.dispatch(id, new URLSearchParams()) : undefined;
  return { kind: 'done', done, id, message: doneKinds[done](id), ...(dispatched === undefined ? {} : { dispatched }) };
}

async function doneAction(ctx: WriteContext, id: string, form: URLSearchParams): Promise<Done> {
  const outcome = one(form, 'outcome');
  if (outcome !== 'done' && outcome !== 'defer' && outcome !== 'handback') throw new Refusal(400, 'Choose Mark done, Not now, or Hand back to agents. Nothing changed.');
  const note = one(form, 'note') ?? '';
  const now = await current(ctx, id);
  const label = `${actions[outcome]} on the current version`;
  const change = outcome === 'handback'
    ? labelCheck(ctx.viewer, form, now.issue, relabel(seenLabels(form), ['owner-action'], ['ready']), label, note)
    : scalarCheck(ctx.viewer, form, now.issue, 'status', outcome === 'done' ? 'closed' : 'deferred', label, note);
  await update(ctx, now, [change]);
  const done: DoneKind = outcome === 'done' ? 'done' : outcome === 'defer' ? 'deferred' : 'handedback';
  const partial = await noteAfter(ctx, id, note, doneKinds[done](id));
  if (partial !== null) return { kind: 'partial', id, message: partial, note };
  return { kind: 'done', done, id, message: doneKinds[done](id) };
}

/**
 * Answers an ask or waives a check from the page. The item's own state is its version: the store moves an item out of open once,
 * so a repeat of the same answer saves nothing new and a different answer after it is refused with the answer that stands.
 * This is the one write that passes the page surface, which lets a person answer an ask their own actor raised from an agent host.
 */
async function resolveItem(ctx: WriteContext, id: string, form: URLSearchParams): Promise<Done> {
  const to = one(form, 'to');
  if (to !== 'answered' && to !== 'waived') throw new Refusal(400, 'The form names neither an answer nor a waiver. Reload the page and try again.');
  const nText = one(form, 'n');
  if (nText === null || !/^[1-9][0-9]{0,15}$/.test(nText) || !Number.isSafeInteger(Number(nText))) throw new Refusal(400, 'The form names no item. Reload the page and try again.');
  const note = (one(form, 'note') ?? '').trim();
  const answer = to === 'answered' ? required(form, 'answer', 'The answer').trim() : undefined;
  if (to === 'waived' && note === '') throw new Refusal(400, 'A waiver needs a reason. Nothing changed.');
  const operation: ItemResolve = { op: 'item_resolve', id, n: Number(nText), to, surface: 'page', ...(answer === undefined ? {} : { answer }), ...(note === '' ? {} : { note }) };
  try {
    await executeOperation(ctx.db, operation, ctx.viewer.actor);
  } catch (error) {
    if (!(error instanceof PolylinedbError) || error.code !== 'item_conflict') throw error;
    const now = (error.details as { item?: { state?: string; answer?: string | null; note?: string | null } } | undefined)?.item;
    const stands = now?.state === 'answered' ? `It was already answered: “${shortTitle(now.answer ?? '', 60)}”.` : now?.state === undefined ? 'It already left open.' : `It is already ${now.state}.`;
    throw new Refusal(409, `${stands} An item leaves open once. Nothing changed.`);
  }
  const done: DoneKind = to === 'answered' ? 'answered' : 'waived';
  return { kind: 'done', done, id, message: doneKinds[done](id) };
}

async function setField(ctx: WriteContext, id: string, form: URLSearchParams, field: 'status' | 'priority' | 'type' | 'body'): Promise<Done> {
  const now = await current(ctx, id);
  let value: unknown;
  if (field === 'status') {
    value = one(form, 'status');
    if (value !== 'open' && value !== 'deferred' && value !== 'closed') throw new Refusal(400, 'Choose Open, Deferred, or Closed. In progress needs an agent’s claim, so agents set it.');
  } else if (field === 'priority') {
    const text = one(form, 'priority');
    if (text === null || !/^[0-4]$/.test(text)) throw new Refusal(400, 'Choose a priority from P0 to P4. Nothing changed.');
    value = Number(text);
  } else if (field === 'type') {
    value = one(form, 'type');
    if (!types.includes(value as typeof types[number])) throw new Refusal(400, `Choose a type: ${types.join(', ')}. Nothing changed.`);
  } else {
    value = required(form, 'body', 'The text');
  }
  const labels = { status: 'Set the status', priority: 'Set the priority', type: 'Save the type', body: 'Save the text' } as const;
  const change = scalarCheck(ctx.viewer, form, now.issue, field, value, `${labels[field]} on the current version`);
  if (change.expected === now.issue.versions[field] && now.issue[field] === value) return { kind: 'saved', id, message: 'Nothing to change: it already has that value.' };
  await update(ctx, now, [change]);
  if (field === 'status') {
    const done: DoneKind = value === 'closed' ? 'closed' : value === 'open' ? 'opened' : 'deferred';
    return { kind: 'done', done, id, message: doneKinds[done](id) };
  }
  const message = field === 'priority' ? `${id} is now P${String(value)}.` : field === 'type' ? `${id} is now a ${String(value)}.` : `The text of ${id} is saved.`;
  return { kind: 'saved', id, message };
}

async function setLabels(ctx: WriteContext, id: string, form: URLSearchParams): Promise<Done> {
  const typed = (one(form, 'labels.new') ?? '').split(/\s+/).filter(Boolean);
  const desired = [...new Set([...form.getAll('labels'), ...typed])];
  const now = await current(ctx, id);
  const change = labelCheck(ctx.viewer, form, now.issue, desired, 'Save labels on the current version');
  await update(ctx, now, [change]);
  return { kind: 'saved', id, message: `Labels of ${id}: ${labelText(change.value as string[])}.` };
}

async function addComment(ctx: WriteContext, id: string, form: URLSearchParams): Promise<Done> {
  await comment(ctx, id, required(form, 'body', 'The comment'));
  return { kind: 'saved', id, message: 'Comment saved.', hash: 'comments' };
}

// A person stars as their actor and no handle, so a star from the page is theirs alone to remove. Both directions are idempotent.
async function starComment(ctx: WriteContext, id: string, form: URLSearchParams): Promise<Done> {
  const commentId = required(form, 'comment', 'The comment id');
  const direction = one(form, 'star');
  if (direction !== 'add' && direction !== 'remove') throw new Refusal(400, 'The form names neither a star nor its removal. Reload the page and try again.');
  await run(ctx, { op: direction === 'add' ? 'star' : 'unstar', id, comment_id: commentId });
  return { kind: 'saved', id, message: direction === 'add' ? 'Starred.' : 'Star removed.' };
}

async function editComment(ctx: WriteContext, id: string, form: URLSearchParams): Promise<Done> {
  const commentId = required(form, 'comment', 'The comment id');
  const body = required(form, 'body', 'The comment');
  const expected = version(form, 'v.comment');
  try {
    await run(ctx, { op: 'comment_edit', id, comment_id: commentId, body, expected });
  } catch (error) {
    if (!(error instanceof PolylinedbError) || error.code !== 'comment_conflict') throw error;
    const now = (error.details as { comment?: { body?: string; version?: number } } | undefined)?.comment;
    throw new Stale({ rows: { saw: 'An earlier version of your comment.', now: `“${shortTitle(now?.body ?? '', 60)}”`, change: `“${shortTitle(body, 60)}”`, result: 'Your text replaces the current comment.' },
      by: 'The comment changed in another window or session.', again: replaced(form, 'v.comment', String(now?.version ?? expected)), outcome: 'Save comment on the current version', note: '' });
  }
  return { kind: 'saved', id, message: 'Comment saved.', hash: 'comments' };
}

async function blockers(ctx: WriteContext, id: string, form: URLSearchParams, add: boolean): Promise<Done> {
  const blocker = issueId(required(form, 'blocker', 'The blocker'), 'The blocker');
  const expected = version(form, 'v.blockers');
  try {
    await run(ctx, { op: add ? 'dependency_add' : 'dependency_remove', dependent_id: id, blocker_id: blocker, expected_revision: expected, request_id: crypto.randomUUID() });
  } catch (error) {
    if (!(error instanceof PolylinedbError)) throw error;
    if (error.code === 'dependency_cycle') throw new Refusal(409, `${blocker} already waits on ${id}, directly or through other issues, so it cannot block it. Nothing changed.`);
    if (error.code !== 'dependency_conflict') throw error;
    const now = (error.details as { current?: { revision?: number; blockers?: { id: string }[] } } | undefined)?.current;
    const ids = (now?.blockers ?? []).map(entry => entry.id);
    const after = add ? [...new Set([...ids, blocker])] : ids.filter(entry => entry !== blocker);
    throw new Stale({ rows: { saw: `Blocker revision ${expected}.`, now: ids.length === 0 ? 'No blockers.' : `Blocked by ${ids.join(', ')}.`,
      change: `${add ? 'Add' : 'Remove'} ${blocker}.`, result: after.length === 0 ? 'No blockers.' : `Blocked by ${after.join(', ')}.` },
      by: 'The blockers changed after you opened the page.', again: replaced(form, 'v.blockers', String(now?.revision ?? expected)),
      outcome: `${add ? 'Add' : 'Remove'} the blocker on the current version`, note: '' });
  }
  return { kind: 'saved', id, message: add ? `${id} now waits on ${blocker}.` : `${blocker} no longer blocks ${id}.`, hash: 'blockers' };
}

async function landOrder(ctx: WriteContext, id: string, form: URLSearchParams): Promise<Done> {
  const op = one(form, 'op');
  if (op !== 'set' && op !== 'clear') throw new Refusal(400, 'Choose Set order or Clear. Nothing changed.');
  const earlier = issueId(required(form, 'after', 'The earlier issue'), 'The earlier issue');
  const expected = version(form, 'v.land');
  try {
    await run(ctx, { op: op === 'set' ? 'land_order_add' : 'land_order_remove', later_id: id, earlier_id: earlier, expected_revision: expected, request_id: crypto.randomUUID() });
  } catch (error) {
    if (!(error instanceof PolylinedbError)) throw error;
    if (error.code === 'dependency_cycle') throw new Refusal(409, `${earlier} already lands after ${id}, directly or through blockers, so the order would loop. Nothing changed.`);
    if (error.code !== 'land_order_conflict') throw error;
    const now = (error.details as { current?: { revision?: number; after?: { id: string }[] } } | undefined)?.current;
    const ids = (now?.after ?? []).map(entry => entry.id);
    const after = op === 'set' ? [...new Set([...ids, earlier])] : ids.filter(entry => entry !== earlier);
    throw new Stale({ rows: { saw: `Land-order revision ${expected}.`, now: ids.length === 0 ? 'No order set.' : `Lands after ${ids.join(', ')}.`,
      change: `${op === 'set' ? 'Land after' : 'Clear “after'} ${earlier}${op === 'set' ? '' : '”'}.`, result: after.length === 0 ? 'No order set.' : `Lands after ${after.join(', ')}.` },
      by: 'The land order changed after you opened the page.', again: replaced(form, 'v.land', String(now?.revision ?? expected)),
      outcome: `${op === 'set' ? 'Set the order' : 'Clear the order'} on the current version`, note: '' });
  }
  return { kind: 'saved', id, message: op === 'set' ? `${id} now lands after ${earlier}.` : `${id} no longer waits for ${earlier} to land.` };
}

export function dispatchSentence(outcome: Exclude<DispatchOutcome, { kind: 'not_found' }>): string {
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
export function dispatchStatus(outcome: Exclude<DispatchOutcome, { kind: 'not_found' }>): number {
  switch (outcome.kind) {
    case 'sent': case 'already_sent': return 200;
    case 'retried': return outcome.delivered ? 200 : 502;
    case 'not_sent': return 502;
    case 'conflict': return 409;
    case 'unavailable': return 503;
    case 'not_permitted': return 403;
    case 'invalid_form': return 400;
    default: { const unreachable: never = outcome; return unreachable; }
  }
}
const dispatchOk = (outcome: DispatchOutcome): boolean => outcome.kind !== 'not_found' && dispatchStatus(outcome) === 200;

/** The three fields of New project. The prefix pattern is the store's, checked here so the sentence can say what to type. */
function freshProject(form: URLSearchParams): FreshProject {
  const field = (name: keyof FreshProject, label: string) => {
    const value = (one(form, `new.${name}`) ?? '').trim();
    if (value === '') throw new Refusal(400, `${label} is empty. Nothing was created.`);
    return value;
  };
  const fresh = { tool: field('tool', 'The tool'), project: field('project', 'The project'), prefix: field('prefix', 'The id prefix') };
  if (!/^[a-z][a-z0-9]{0,15}$/.test(fresh.prefix)) throw new Refusal(400, 'The id prefix takes 1 to 16 lowercase letters or digits, starting with a letter. Nothing was created.');
  return fresh;
}

async function created(ctx: WriteContext, form: URLSearchParams): Promise<{ id: string; dispatched?: DispatchOutcome }> {
  const chosen = required(form, 'project', 'The project');
  const fresh = chosen === newProject ? freshProject(form) : null;
  const [tool, project, ...extra] = fresh === null ? chosen.split('\n') : [fresh.tool, fresh.project];
  if (tool === undefined || project === undefined || extra.length > 0) throw new Refusal(400, 'Choose a project from the list. Nothing was created.');
  const body = required(form, 'body', 'The text');
  const type = one(form, 'type') ?? 'task';
  if (!types.includes(type as typeof types[number])) throw new Refusal(400, `Choose a type: ${types.join(', ')}. Nothing was created.`);
  const priorityText = one(form, 'priority') ?? '2';
  if (!/^[0-4]$/.test(priorityText)) throw new Refusal(400, 'Choose a priority from P0 to P4. Nothing was created.');
  const labels = [...new Set(form.getAll('labels'))];
  if (!labels.every(label => newLabels.includes(label as typeof newLabels[number]))) throw new Refusal(400, `A new issue takes only these labels here: ${newLabels.join(', ')}. Nothing was created.`);
  const parentText = (one(form, 'parent') ?? '').trim();
  const parent = parentText === '' ? undefined : issueId(parentText, 'The parent');
  // The store asks for the id prefix; a project keeps the prefix of its existing issues, and a new one takes the typed prefix.
  const sample = await run(ctx, { op: 'list', tool, project, limit: 1 });
  const kept = 'issues' in sample ? sample.issues[0]?.id.split('-')[0] : undefined;
  if (fresh !== null && kept !== undefined && kept !== fresh.prefix) throw new Refusal(400, `${project} already has issues with the prefix ${kept}. Choose it from the list. Nothing was created.`);
  const prefix = fresh?.prefix ?? kept;
  if (prefix === undefined) throw new Refusal(404, 'That project has no issue yet. Choose New project and give its prefix. Nothing was created.');
  const result = await run(ctx, { op: 'create', tool, project, body, type, priority: Number(priorityText), labels, prefix, request_id: crypto.randomUUID(), ...(parent === undefined ? {} : { parent }) });
  const id = issueOf(result).id;
  const dispatched = one(form, 'then') === 'dispatch' && ctx.viewer.dispatch === 'ready' ? await ctx.dispatch(id, new URLSearchParams()) : undefined;
  return dispatched === undefined ? { id } : { id, dispatched };
}

/** Mark landed: per ticked issue, remove main-wait and comment. It cannot see the push; it records what the person says landed. */
async function landed(ctx: WriteContext, form: URLSearchParams): Promise<{ done: string[]; gone: string[]; failed: string[] }> {
  const ids = [...new Set(form.getAll('landed'))].slice(0, 100).map(value => issueId(value, 'A ticked issue'));
  if (ids.length === 0) throw new Refusal(400, 'Tick at least one issue that landed. Nothing changed.');
  const out = { done: [] as string[], gone: [] as string[], failed: [] as string[] };
  for (const id of ids) {
    try {
      const now = await current(ctx, id);
      if (!now.issue.labels.includes('main-wait')) { out.gone.push(id); continue; }
      // Removing main-wait touches no other label, so a newer label version still merges onto the current list.
      await update(ctx, now, [{ field: 'labels', value: now.issue.labels.filter(label => label !== 'main-wait'), expected: now.issue.versions.labels }]);
      await comment(ctx, id, 'Landed on main.');
      out.done.push(id);
    } catch (error) {
      if (!(error instanceof PolylinedbError)) throw error;
      out.failed.push(id);
    }
  }
  return out;
}

/** The sentence for /ui/landing?landed=…&gone=…&failed=…, from ids only. */
export function landedSentence(params: URLSearchParams): string {
  const list = (name: string) => (params.get(name) ?? '').split(',').filter(Boolean).flatMap(value => { try { return [parseIssueId(value)]; } catch { return []; } }).slice(0, 100);
  const [done, gone, failed] = [list('landed'), list('gone'), list('failed')];
  if (done.length + gone.length + failed.length === 0) return '';
  const parts = [
    ...(done.length === 0 ? [] : [`Marked landed: ${done.map(idLink).join(', ')}. Each lost main-wait and got the comment “Landed on main.”`]),
    ...(gone.length === 0 ? [] : [`Already off the queue: ${gone.map(idLink).join(', ')}.`]),
    ...(failed.length === 0 ? [] : [`Not saved: ${failed.map(idLink).join(', ')}. Open each one and try again.`]),
  ];
  return `<div class="flash l-land" role="status">${icon('check')}<div><p>${parts.join(' ')}</p></div></div>`;
}

async function counts(ctx: WriteContext) {
  return tabCounts(composeLanes(await readBadgeLanes(ctx.db)));
}

function conflictSection(action: string, conflict: Conflict, back: string): string {
  const row = (label: string, text: string) => `<div><span class="lbl">${label}</span>${escape(text)}</div>`;
  const note = conflict.note === '' ? '' : `<div class="field"><label for="cf-note">Your note, kept</label><textarea id="cf-note" name="note" rows="3">${escape(conflict.note)}</textarea></div>`;
  return `<section class="conflict" id="conflict" role="alert" aria-labelledby="cf-h"><h2 id="cf-h">${icon('warn')}Someone changed this after you opened it</h2>`
    + `<p>Nothing was saved. ${escape(conflict.by)}</p><div class="diff">${row('You saw', conflict.rows.saw)}${row('Now', conflict.rows.now)}${row('Your change', conflict.rows.change)}${row('Result if applied now', conflict.rows.result)}</div>`
    + `<form method="post" action="${escape(action)}">${conflict.again.map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`).join('')}${note}<div class="btn-row"><button class="btn">${escape(conflict.outcome)}</button>`
    + `<a class="btn ghost" href="${escape(back)}">Discard my change</a></div></form></section>`;
}

function partialSection(id: string, message: string, note: string, back: string): string {
  return `<section class="conflict" id="conflict" role="alert" aria-labelledby="cf-h"><h2 id="cf-h">${icon('warn')}Saved, but the note was not</h2><p>${escape(message)}</p>`
    + `<form method="post" action="/ui/i/${escape(id)}/comment">${hidden({ return: back })}<div class="field"><label for="cf-note">Your note, kept</label>`
    + `<textarea id="cf-note" name="body" rows="3">${escape(note)}</textarea></div><button class="btn">Send as a comment</button></form></section>`;
}

async function pageAnswer(ctx: WriteContext, status: number, id: string, top: string, note = ''): Promise<WriteAnswer> {
  const [view, tabs] = await Promise.all([readIssueView(ctx.db, id, ctx.viewer.actor), counts(ctx)]);
  if (view === null) return { status: 404, html: messagePage('Not found', 'This issue does not exist.', ctx.viewer, tabs) };
  return { status, html: issuePage(view, ctx.viewer, tabs, top, note) };
}

// 409 means a stale version, and the fixed script answers it by sending the form natively for the conflict page. Any other refusal is 422.
async function refusal(ctx: WriteContext, json: boolean, given: number, message: string, back: string): Promise<WriteAnswer> {
  const status = given === 409 ? 422 : given;
  if (json) return { status, json: { ok: false, message } };
  return { status, html: messagePage('Not saved', escape(message), ctx.viewer, await counts(ctx), `<p><a class="btn ghost" href="${escape(back)}">Go back</a></p>`) };
}

function failureSentence(error: PolylinedbError): string {
  switch (error.code) {
    case 'not_found': return 'That issue does not exist. Nothing changed.';
    case 'claim_required': return 'This change needs a claim on the issue, and you hold none. Nothing changed.';
    case 'read_only_actor': return 'This sign-in can only read. Writes wait on the owner.';
    case 'comment_author_required': return 'Only the author of a comment can edit it. Nothing changed.';
    case 'comment_not_found': return 'That comment is not on this issue. Nothing changed.';
    case 'star_owner_required': return 'Only the one who gave a star can remove it. Nothing changed.';
    case 'dependency_blocked': return 'The issue has active blockers, so it cannot start. Nothing changed.';
    case 'epic_has_children': return 'An epic with children stays an epic. Nothing changed.';
    case 'item_not_found': return 'That ask or check is not on this issue. Nothing changed.';
    case 'items_open': return 'Open asks or unmet checks hold this issue. Answer, meet, or waive them first, or close it with force from the CLI. Nothing changed.';
    default: return `${error.message}. Nothing changed.`.replace('.. ', '. ');
  }
}

/** Runs one write and shapes the answer. A reader never reaches the store; the store still checks every write again. */
export async function uiWrite(route: WriteRoute, form: URLSearchParams | 'invalid', json: boolean, ctx: WriteContext): Promise<WriteAnswer> {
  const fallback = route.kind === 'issue' ? `/ui/i/${route.id}` : route.kind === 'new' ? '/ui/new' : '/ui/landing';
  // Dispatch reads its own form and decides who may press it, so its sentences stay the dispatcher's.
  if (route.kind === 'issue' && route.action === 'dispatch') {
    const back = form === 'invalid' || form.getAll('return').length !== 1 ? fallback : returnPath(form.get('return'), fallback);
    const outcome = await ctx.dispatch(route.id, form);
    if (outcome.kind === 'not_found') return refusal(ctx, json, 404, 'That issue does not exist. Nothing was sent.', back);
    const message = dispatchSentence(outcome);
    if (json) return { status: dispatchStatus(outcome) === 409 ? 422 : dispatchStatus(outcome), json: { ok: dispatchOk(outcome), message } };
    if (dispatchOk(outcome)) return { status: 303, location: withDone(back, 'dispatched', route.id) };
    return refusal(ctx, false, dispatchStatus(outcome), message, back);
  }
  if (form === 'invalid') return refusal(ctx, json, 400, 'The form could not be read. Reload the page and try again.', fallback);
  let back: string;
  try { back = returnPath(one(form, 'return'), fallback); } catch (error) { return refusal(ctx, json, 400, (error as Error).message, fallback); }
  if (ctx.viewer.role === 'reader') return refusal(ctx, json, 403, 'Signed in as a reader. Writes wait on the owner.', back);
  try {
    if (route.kind === 'landed') {
      const result = await landed(ctx, form);
      const message = [result.done.length === 0 ? '' : `Marked landed: ${result.done.join(', ')}.`, result.gone.length === 0 ? '' : `Already off the queue: ${result.gone.join(', ')}.`,
        result.failed.length === 0 ? '' : `Not saved: ${result.failed.join(', ')}.`].filter(Boolean).join(' ');
      if (json) return { status: result.failed.length === 0 ? 200 : 422, json: { ok: result.failed.length === 0, message } };
      const query = new URLSearchParams();
      if (result.done.length > 0) query.set('landed', result.done.join(','));
      if (result.gone.length > 0) query.set('gone', result.gone.join(','));
      if (result.failed.length > 0) query.set('failed', result.failed.join(','));
      return { status: 303, location: `/ui/landing?${query.toString().replaceAll('%2C', ',')}` };
    }
    if (route.kind === 'new') {
      let made: { id: string; dispatched?: DispatchOutcome };
      try { made = await created(ctx, form); }
      catch (error) {
        const message = error instanceof Refusal ? error.message : error instanceof PolylinedbError ? failureSentence(error).replace('Nothing changed.', 'Nothing was created.') : null;
        if (message === null) throw error;
        const given = error instanceof Refusal ? error.status : (error as PolylinedbError).status;
        const status = given === 409 ? 422 : given;
        if (json) return { status, json: { ok: false, message } };
        const [lanes, projects] = await Promise.all([counts(ctx), projectSummaries(ctx.db, 200)]);
        const typed = { tool: one(form, 'new.tool') ?? '', project: one(form, 'new.project') ?? '', prefix: one(form, 'new.prefix') ?? '' };
        return { status, html: newPage(projects, one(form, 'project'), ctx.viewer, lanes, message, one(form, 'body') ?? '', typed) };
      }
      const sent = made.dispatched === undefined || made.dispatched.kind === 'not_found' ? '' : ` Dispatch: ${dispatchSentence(made.dispatched)}`;
      if (json) return { status: 200, json: { ok: true, message: `${made.id} is created.${sent}` } };
      return { status: 303, location: withDone(`/ui/i/${made.id}`, made.dispatched !== undefined && dispatchOk(made.dispatched) ? 'dispatched' : 'created', made.id) };
    }
    const id = route.id;
    const handlers: Record<Exclude<IssueAction, 'dispatch'>, () => Promise<Done>> = {
      decide: () => decide(ctx, id, form), done: () => doneAction(ctx, id, form), item: () => resolveItem(ctx, id, form), comment: () => addComment(ctx, id, form), 'comment-edit': () => editComment(ctx, id, form),
      star: () => starComment(ctx, id, form),
      status: () => setField(ctx, id, form, 'status'), priority: () => setField(ctx, id, form, 'priority'), type: () => setField(ctx, id, form, 'type'),
      labels: () => setLabels(ctx, id, form), body: () => setField(ctx, id, form, 'body'),
      'blockers/add': () => blockers(ctx, id, form, true), 'blockers/remove': () => blockers(ctx, id, form, false), 'land-order': () => landOrder(ctx, id, form),
    };
    if (route.action === 'dispatch') throw new PolylinedbError('storage_error', 'Dispatch was routed past its handler', 500);
    const result = await handlers[route.action]();
    if (result.kind === 'partial') {
      if (json) return { status: 500, json: { ok: false, message: result.message } };
      return pageAnswer(ctx, 500, id, partialSection(id, result.message, result.note, back));
    }
    const sent = result.kind === 'done' && result.dispatched !== undefined && result.dispatched.kind !== 'not_found' ? ` Dispatch: ${dispatchSentence(result.dispatched)}` : '';
    if (json) return { status: 200, json: { ok: true, message: `${result.message}${sent}` } };
    if (result.kind === 'done') return { status: 303, location: withDone(back, result.dispatched !== undefined && dispatchOk(result.dispatched) ? 'dispatched' : result.done, id) };
    return { status: 303, location: result.hash === undefined || back.includes('#') ? back : `${back}#${result.hash}` };
  } catch (error) {
    if (error instanceof Stale) {
      if (json) return { status: 409, json: { ok: false, message: 'Someone changed this after you opened it. Nothing was saved.' } };
      if (route.kind !== 'issue') return refusal(ctx, false, 409, 'Someone changed this after you opened it. Nothing was saved.', back);
      return pageAnswer(ctx, 409, route.id, conflictSection(`/ui/i/${route.id}/${route.action}`, error.conflict, back), error.conflict.note);
    }
    if (error instanceof Refusal) return refusal(ctx, json, error.status, error.message, back);
    if (error instanceof PolylinedbError && error.status < 500) {
      // A stale version the read did not see, because a write landed between the read and the update: show the current state as a conflict.
      if (error.code === 'conflict' && route.kind === 'issue') {
        const issue = (error.details as { issue?: Issue } | undefined)?.issue;
        const conflict: Conflict = { rows: { saw: 'An earlier version.', now: issue === undefined ? 'A newer version.' : `${statusWord(issue.status)}, P${issue.priority}, ${labelText(issue.labels)}.`,
          change: 'Your change.', result: 'Read the page again, then decide.' }, by: issue === undefined ? '' : by(ctx.viewer, issue), again: issue === undefined ? [...form].filter(([name]) => name !== 'note') : refreshed(form, issue),
          outcome: 'Apply on the current version', note: one(form, 'note') ?? '' };
        if (json) return { status: 409, json: { ok: false, message: 'Someone changed this after you opened it. Nothing was saved.' } };
        return pageAnswer(ctx, 409, route.id, conflictSection(`/ui/i/${route.id}/${route.action}`, conflict, back), conflict.note);
      }
      return refusal(ctx, json, error.status, failureSentence(error), back);
    }
    throw error;
  }
}

/** The ?done= value of a page, when it names a known kind and a valid issue id. */
export function doneParam(value: string | null): { kind: DoneKind; id: string } | null {
  if (value === null) return null;
  const colon = value.indexOf(':');
  const kind = value.slice(0, colon);
  if (colon < 1 || !Object.hasOwn(doneKinds, kind)) return null;
  try { return { kind: kind as DoneKind, id: parseIssueId(value.slice(colon + 1)) }; } catch { return null; }
}

