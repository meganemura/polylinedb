/**
 * Composes the four lanes of /ui from store reads: You, Agents, Landing, and Stuck.
 * `readLanes` runs every read in parallel; `composeLanes` is pure and owns the dedupe rules, so one function decides what each lane shows.
 */
import { activeClaimIssues, activitySince, attentionIssues, blockedIssues, executeOperation, openAsksByIssue, startedWithoutClaim, watchedLeases, PolylinedbError,
  type ActiveClaimIssue, type ActivityCount, type Actor, type Attention, type BlockedIssue, type Issue, type OpenAsk, type StartedIssue, type WatchedLease } from '../../records/index.ts';
import type { SqlExecutor } from '../../records/persistence/persistence.ts';

export const pageLimit = 50;
const readLimit = 101;
/** Open asks the lanes read: enough for every You item a page lists to carry its first ask. */
const askLimit = 200;
const lockLabel = 'main-lock';
const ownerLabels = ['owner-decision', 'owner-action'] as const;

export type LaneReads = {
  attention: Attention;
  /** Open asks by issue. Empty on the badge reads, which count asks from the attention rows alone. */
  asks: ReadonlyMap<string, readonly OpenAsk[]>;
  claims: readonly ActiveClaimIssue[];
  leases: readonly WatchedLease[];
  started: { rows: readonly StartedIssue[]; total: number; expired: number };
  blocked: { rows: readonly BlockedIssue[]; total: number };
  ready: readonly Issue[];
  queue: readonly { issue: Issue; after: readonly string[]; revision: number }[];
  locks: readonly Issue[];
  since: readonly ActivityCount[];
};

/**
 * An owner item. `after` names the active blockers it starts after; `blocks` names the You items that wait on it.
 * An issue with an open ask is an answer item whatever its labels say, because the ask names the exact question; `asks` holds its open asks.
 */
export type YouItem = { issue: Issue; kind: 'answer' | 'decide' | 'do'; waitedSeconds: number | null; after: readonly string[]; blocks: readonly string[]; asks: readonly OpenAsk[] };
export type QueueItem = { issue: Issue; position: number; after: readonly string[]; revision: number };
export type Lanes = {
  you: readonly YouItem[];
  answer: number;
  decide: number;
  todo: number;
  /** Deferred owner items: out of sight until reopened. */
  parked: number;
  claims: readonly ActiveClaimIssue[];
  /** Claims on main-lock issues. A lock is never a work row; it is a sentence. */
  locks: readonly ActiveClaimIssue[];
  lockIssues: readonly Issue[];
  ready: readonly Issue[];
  queue: readonly QueueItem[];
  /** Expired leases on started issues, and leases on any unfinished issue that expired after an error report. */
  expired: readonly (StartedIssue | WatchedLease)[];
  /** Live leases whose holder went quiet or reported an error: the lease alone would not show them until it expired. */
  silent: readonly WatchedLease[];
  stale: readonly StartedIssue[];
  staleTotal: number;
  blocked: readonly BlockedIssue[];
  blockedTotal: number;
  since: readonly ActivityCount[];
};

const isLock = (issue: Issue): boolean => issue.labels.includes(lockLabel);
const isOwnerItem = (row: Attention['issues'][number]): boolean => row.openAsks > 0 || ownerLabels.some(label => row.issue.labels.includes(label));
const kindOrder = { answer: 0, decide: 1, do: 2 } as const;

/** Every read of the lanes, in one parallel wave. */
export async function readLanes(db: SqlExecutor, actor: Actor): Promise<LaneReads> {
  const [attention, asks, claims, leases, started, blocked, ready, queue, locks, since] = await Promise.all([
    attentionIssues(db),
    openAsksByIssue(db, askLimit),
    activeClaimIssues(db, readLimit),
    watchedLeases(db, readLimit),
    startedWithoutClaim(db, readLimit),
    blockedIssues(db, readLimit),
    executeOperation(db, { op: 'dependency_worklist', state: 'ready', label: 'ready', limit: 100 }, actor),
    executeOperation(db, { op: 'list', label: 'main-wait', status: 'open', with_land_order: true, limit: 100 }, actor),
    executeOperation(db, { op: 'list', label: lockLabel, limit: 100 }, actor),
    activitySince(db, 86400),
  ]);
  if (!('issues' in ready) || !('issues' in queue) || !('land_order' in queue) || !Array.isArray(queue.land_order) || !('issues' in locks)) {
    throw new PolylinedbError('storage_error', 'Lane reads are unavailable', 500);
  }
  const orders = queue.land_order;
  return {
    attention, asks, claims, leases, started, blocked, ready: ready.issues, locks: locks.issues.filter(issue => issue.status !== 'closed'), since,
    queue: queue.issues.map((issue, index) => ({ issue, after: orders[index]?.after.map(entry => entry.id) ?? [], revision: orders[index]?.revision ?? 1 })),
  };
}

/**
 * The reads behind the tab badges alone. Today counts You items and Stuck counts expired, quiet, and errored claims plus blocked
 * issues, and the dedupe between them needs only the attention, watched lease, started, and blocked reads, so a page outside the lanes skips the other five.
 */
export async function readBadgeLanes(db: SqlExecutor): Promise<LaneReads> {
  const [attention, leases, started, blocked] = await Promise.all([attentionIssues(db), watchedLeases(db, readLimit), startedWithoutClaim(db, readLimit), blockedIssues(db, readLimit)]);
  return { attention, asks: new Map(), claims: [], leases, started, blocked, ready: [], queue: [], locks: [], since: [] };
}

/** The dedupe rules: a You item is not also Ready, Expired, or Stale; an expired claim is not also Stale; a lock is never a row. Blocked may repeat a You item. */
export function composeLanes(reads: LaneReads): Lanes {
  const owner = reads.attention.issues.filter(row => isOwnerItem(row) && row.issue.status !== 'closed');
  const blockersOf = new Map(reads.blocked.rows.map(row => [row.issue.id, row.blockerIds]));
  const active = owner.filter(row => row.issue.status !== 'deferred');
  const youIds = new Set(active.map(row => row.issue.id));
  const items = active.map((row): YouItem => ({
    issue: row.issue,
    kind: row.openAsks > 0 ? 'answer' : row.issue.labels.includes('owner-decision') ? 'decide' : 'do',
    waitedSeconds: row.waitingSeconds,
    asks: reads.asks.get(row.issue.id) ?? [],
    after: blockersOf.get(row.issue.id) ?? [],
    blocks: active.filter(other => (blockersOf.get(other.issue.id) ?? []).includes(row.issue.id)).map(other => other.issue.id),
  })).sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind]
    || a.issue.priority - b.issue.priority
    || (b.waitedSeconds ?? -1) - (a.waitedSeconds ?? -1)
    || a.issue.id.localeCompare(b.issue.id));
  const claimed = new Set(reads.claims.map(row => row.issue.id));
  const shown = (issue: Issue) => !youIds.has(issue.id) && !isLock(issue);
  const errored = new Map(reads.leases.filter(row => row.claim.state === 'expired' && row.run.state === 'errored' && shown(row.issue)).map(row => [row.issue.id, row]));
  const startedExpired = reads.started.rows.filter(row => row.claim.state === 'expired' && shown(row.issue));
  const startedIds = new Set(startedExpired.map(row => row.issue.id));
  const expired = [...startedExpired.map(row => errored.get(row.issue.id) ?? row), ...[...errored.values()].filter(row => !startedIds.has(row.issue.id))];
  const notExpired = reads.started.rows.filter(row => row.claim.state !== 'expired');
  const stale = notExpired.filter(row => shown(row.issue));
  return {
    you: items,
    answer: items.filter(item => item.kind === 'answer').length,
    decide: items.filter(item => item.kind === 'decide').length,
    todo: items.filter(item => item.kind === 'do').length,
    parked: owner.length - active.length,
    claims: reads.claims.filter(row => !isLock(row.issue)),
    locks: reads.claims.filter(row => isLock(row.issue)),
    lockIssues: reads.locks,
    ready: reads.ready.filter(issue => !claimed.has(issue.id) && shown(issue)),
    queue: landOrder(reads.queue.filter(row => !isLock(row.issue))),
    expired,
    silent: reads.leases.filter(row => row.claim.state === 'active' && !isLock(row.issue) && (row.run.state === 'quiet' || row.run.state === 'errored')),
    stale,
    staleTotal: Math.max(stale.length, reads.started.total - reads.started.expired - (notExpired.length - stale.length)),
    blocked: reads.blocked.rows.filter(row => !isLock(row.issue)),
    blockedTotal: reads.blocked.total,
    since: reads.since,
  };
}

/** Expired claims, quiet or errored live claims, and blocked issues: the Stuck count on the tab and the lane. */
export const stuckCount = (lanes: Lanes): number => lanes.expired.length + lanes.silent.length + lanes.blockedTotal;

/** A topological order over the land-order edges inside the queue; ties go to the least recently updated, then the id. */
function landOrder(rows: LaneReads['queue']): QueueItem[] {
  const ids = new Set(rows.map(row => row.issue.id));
  const waiting = new Map(rows.map(row => [row.issue.id, row.after.filter(id => ids.has(id))]));
  const placed: QueueItem[] = [];
  const done = new Set<string>();
  const order = (a: LaneReads['queue'][number], b: LaneReads['queue'][number]) => a.issue.updated_at.localeCompare(b.issue.updated_at) || a.issue.id.localeCompare(b.issue.id);
  let left = [...rows].sort(order);
  while (left.length > 0) {
    const next = left.find(row => (waiting.get(row.issue.id) ?? []).every(id => done.has(id))) ?? left[0]!;
    placed.push({ issue: next.issue, position: placed.length + 1, after: next.after, revision: next.revision });
    done.add(next.issue.id);
    left = left.filter(row => row !== next);
  }
  return placed;
}
