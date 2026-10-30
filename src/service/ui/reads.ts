/** The store reads behind /ui pages other than the lanes: one issue with everything its page shows, search hits, and the activity feed. Nothing here writes. */
import { activityAfter, activityNewest, claimDisplay, executeOperation, issueChildren, issueParent, parseIssueId, PolylinedbError,
  type ActivityPage, type Actor, type Issue } from '../../records/index.ts';
import type { SqlExecutor } from '../../records/persistence/persistence.ts';
import type { ActivityCursor, IssueView } from './pages.ts';
import { pageLimit } from './today.ts';

const childLimit = 101;
const shownChildren = 100;

async function issueBlockers(db: SqlExecutor, id: string, actor: Actor): Promise<{ blockers: { id: string; status: Issue['status'] }[]; revision: number }> {
  const blockers: { id: string; status: Issue['status'] }[] = [];
  const seen = new Set<string>();
  let after: string | undefined;
  for (;;) {
    const result = await executeOperation(db, { op: 'dependency_list', dependent_id: id, limit: 100, ...(after === undefined ? {} : { after }) }, actor);
    if (!('blockers' in result) || !('revision' in result)) throw new PolylinedbError('storage_error', 'Blockers are unavailable', 500);
    blockers.push(...result.blockers);
    if (result.next_cursor === null) return { blockers, revision: result.revision };
    if (seen.has(result.next_cursor)) throw new PolylinedbError('storage_error', 'Blocker page repeated', 500);
    seen.add(result.next_cursor);
    after = result.next_cursor;
  }
}

/** Every read of the issue page in one parallel wave, or null when the issue does not exist. */
export async function readIssueView(db: SqlExecutor, id: string, actor: Actor): Promise<(IssueView & { incarnation: string }) | null> {
  try {
    const [shown, blockers, landOrder, parent, children] = await Promise.all([
      executeOperation(db, { op: 'show', id }, actor),
      issueBlockers(db, id, actor),
      executeOperation(db, { op: 'land_order_list', issue_id: id }, actor),
      issueParent(db, id),
      issueChildren(db, id, childLimit),
    ]);
    if (!('comments' in shown) || !('after' in landOrder) || !('before' in landOrder) || !('revision' in landOrder)) throw new PolylinedbError('storage_error', 'Issue detail is unavailable', 500);
    const display = claimDisplay(shown.claim);
    return {
      issue: shown.issue, comments: shown.comments,
      claim: shown.claim.lease === null ? display : { ...display, acquiredAt: shown.claim.lease.acquired_at },
      blockers: blockers.blockers, dependencyRevision: blockers.revision,
      landOrder: { revision: landOrder.revision, after: landOrder.after, before: landOrder.before },
      parent, children: children.slice(0, shownChildren), moreChildren: children.length > shownChildren,
      items: shown.items ?? [],
      discoveredFrom: shown.discovered_from ?? null, discovered: shown.discovered ?? [],
      incarnation: shown.claim.store_incarnation,
    };
  } catch (error) {
    if (error instanceof PolylinedbError && error.code === 'not_found') return null;
    throw error;
  }
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

/** An issue id goes first when it exists; the literal search fills the rest. */
export async function searchHits(db: SqlExecutor, query: string, actor: Actor): Promise<{ hits: Issue[]; more: boolean; rejected: boolean }> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return { hits: [], more: false, rejected: false };
  let id: string | null = null;
  try { id = parseIssueId(trimmed); } catch { id = null; }
  const lookup = id === null ? Promise.resolve(null) : directHit(db, id, actor);
  if (trimmed.includes('\u0000') || new TextEncoder().encode(trimmed).length > 65536) {
    const direct = await lookup;
    return { hits: direct === null ? [] : [direct], more: false, rejected: direct === null };
  }
  const [direct, result] = await Promise.all([lookup, executeOperation(db, { op: 'search', query: trimmed, limit: pageLimit }, actor)]);
  if (!('issues' in result) || !('next_cursor' in result)) throw new PolylinedbError('storage_error', 'Search is unavailable', 500);
  const rest = result.issues.filter(issue => issue.id !== direct?.id);
  return { hits: direct === null ? rest : [direct, ...rest], more: result.next_cursor !== null, rejected: false };
}

/** The feed page, or the sentence that says why a kept link no longer works. */
export async function readActivity(db: SqlExecutor, after: ActivityCursor | 'invalid' | undefined): Promise<ActivityPage | { problem: string }> {
  if (after === undefined) return activityNewest(db, pageLimit);
  if (after === 'invalid') return { problem: 'This activity link is not valid.' };
  try {
    return await activityAfter(db, after.since, after.incarnation, pageLimit);
  } catch (error) {
    if (!(error instanceof PolylinedbError)) throw error;
    if (error.code === 'incarnation_mismatch') return { problem: 'This activity link is from another store.' };
    if (error.code === 'cursor_expired') return { problem: 'Some events after this link were removed.' };
    if (error.code === 'invalid_input') return { problem: 'This activity link is not valid.' };
    throw error;
  }
}
