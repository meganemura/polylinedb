// Owns prerequisite graphs and immutable mutation receipts; issue fields remain a separate aggregate.
import { parseIssueId, parseRequestId, issueSortKey } from './issue-id.ts';
import { parseOperation as parseIssue, issueRow } from './issues.ts';
import { PolylinedbError, requireFields } from './errors.ts';
import type { Operation as IssueOperation, Issue, SqlExecutor, SqlStatement, Status } from './issues.ts';
import { issueQueries } from './issue-queries.ts';
import { decidePrerequisiteEdit, decideReplay } from '../transition/index.ts';
import type { Actor } from '../transition/index.ts';
import { agentHoldsClaim, asActor, heldClaimObservation, rejectAgentWrite } from './agent-gate.ts';

type WorkFilters = Omit<Extract<IssueOperation, { op: 'list' }>, 'op' | 'status'>;
export type DependencyMutation = { op: 'dependency_add' | 'dependency_remove'; dependent_id: string; blocker_id: string; expected_revision: number; request_id: string };
export type DependencyOperation = DependencyMutation | { op: 'dependency_list'; dependent_id: string; after?: string; limit: number }
  | ({ op: 'dependency_worklist'; state: 'ready' | 'blocked' } & WorkFilters);
export type DependencyOutcome = 'added' | 'already_present' | 'removed' | 'already_absent';
export type DependencyReceipt = { dependent_id: string; blocker_id: string; revision: number; outcome: DependencyOutcome };
export type DependencyRequest = { request_id: string; actor: string; payload: string; dependent_id: string; blocker_id: string; result_revision: number; outcome: DependencyOutcome; created_at: string };
export type Dependency = { dependent_id: string; blocker_id: string };
export type DependencyRevision = { dependent_id: string; revision: number };
export type DependencyResult = { dependency: DependencyReceipt } | { dependent_id: string; revision: number; blockers: { id: string; project: string; status: Status }[]; next_cursor: string | null }
  | { issues: Issue[]; next_cursor: string | null };
const idSchema = { type: 'string', pattern: String.raw`^[a-z][a-z0-9]{0,15}-[1-9][0-9]*(\.[1-9][0-9]*){0,7}$` };
const limitSchema = { type: 'integer', minimum: 1, maximum: 100, default: 50 };
const revisionSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const nameSchema = { type: 'string', minLength: 1, maxLength: 256 };
const mutationSchema = { type: 'object', additionalProperties: false, required: ['dependent_id', 'blocker_id', 'expected_revision', 'request_id'], properties: {
  dependent_id: idSchema, blocker_id: idSchema, expected_revision: revisionSchema, request_id: { type: 'string', format: 'uuid', description: 'Reuse one lowercase UUID for each logical mutation.' },
} };
export const dependencySchemas = {
  dependency_add: mutationSchema, dependency_remove: mutationSchema,
  dependency_list: { type: 'object', additionalProperties: false, required: ['dependent_id'], properties: { dependent_id: idSchema, after: idSchema, limit: limitSchema } },
  dependency_worklist: { type: 'object', additionalProperties: false, required: ['state'], properties: { state: { type: 'string', enum: ['ready', 'blocked'] }, tool: nameSchema, project: nameSchema, type: { type: 'string', enum: ['bug', 'task', 'epic', 'feature', 'chore'] }, priority: { type: 'integer', minimum: 0, maximum: 4 }, label: nameSchema, after: idSchema, limit: limitSchema } },
};
const invalid = (message: string): never => { throw new PolylinedbError('invalid_input', message); };
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return invalid('expected_revision must be a positive safe integer');
  return value;
}
export function parseDependencyOperation(value: unknown): DependencyOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return invalid('operation must be a plain object');
  if (!('op' in value)) return invalid('Missing op');
  const op = value.op;
  if (op !== 'dependency_add' && op !== 'dependency_remove' && op !== 'dependency_list' && op !== 'dependency_worklist') return invalid('Unknown dependency operation');
  const schema = dependencySchemas[op];
  requireFields(value as Record<string, unknown>, ['op', ...Object.keys(schema.properties)], schema.required);
  try {
    if (op === 'dependency_worklist') {
      if (!('state' in value) || (value.state !== 'ready' && value.state !== 'blocked')) return invalid('state must be ready or blocked');
      const { state, ...input } = value;
      const filters = parseIssue({ ...input, op: 'list' });
      if (filters.op !== 'list') return invalid('Invalid filters');
      const { op: _, status: __, ...workFilters } = filters;
      return { op, state, ...workFilters };
    }
    if (!('dependent_id' in value)) return invalid('Missing dependent_id');
    const dependent_id = parseIssueId(value.dependent_id);
    if (op === 'dependency_list') {
      const list = parseIssue({ op: 'list', ...('after' in value ? { after: value.after } : {}), ...('limit' in value ? { limit: value.limit } : {}) });
      if (list.op !== 'list') return invalid('Invalid page');
      return { op, dependent_id, limit: list.limit, ...(list.after === undefined ? {} : { after: list.after }) };
    }
    if (!('blocker_id' in value) || !('expected_revision' in value) || !('request_id' in value)) return invalid('Missing mutation fields');
    return { op, dependent_id, blocker_id: parseIssueId(value.blocker_id), expected_revision: revision(value.expected_revision), request_id: parseRequestId(value.request_id) };
  } catch (error) {
    if (error instanceof PolylinedbError) throw error;
    return invalid(error instanceof Error ? error.message : 'Invalid dependency input');
  }
}
export const ACTIVE_BLOCKERS_SQL = "EXISTS(SELECT 1 FROM dependencies JOIN issues AS blocker ON blocker.id = dependencies.blocker_id WHERE dependencies.dependent_id = issues.id AND blocker.status <> 'closed')";
function outcome(value: unknown): DependencyOutcome {
  if (value === 'added' || value === 'already_present' || value === 'removed' || value === 'already_absent') return value;
  throw new PolylinedbError('invalid_store', 'Invalid dependency outcome', 500);
}
export function dependencyReceipt(row: Record<string, unknown>): DependencyReceipt {
  return { dependent_id: parseIssueId(row.dependent_id), blocker_id: parseIssueId(row.blocker_id), revision: revision(row.result_revision), outcome: outcome(row.outcome) };
}
function rowsAt(results: readonly { rows: readonly Record<string, unknown>[] }[], index: number) {
  const result = results[index];
  if (!result) throw new PolylinedbError('storage_error', 'Database omitted a dependency result', 503);
  return result.rows;
}
function knownError(error: unknown, marker: string): boolean {
  let cause = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && cause instanceof Error && !seen.has(cause); depth++) {
    seen.add(cause);
    const suffixes = ['', ': SQLITE_CONSTRAINT', ': SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)', ': SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)', ': SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)'];
    if (suffixes.some(suffix => cause instanceof Error && (cause.message === marker + suffix || cause.message === `D1_ERROR: ${marker}${suffix}`))) return true;
    cause = cause.cause;
  }
  return false;
}
export async function executeDependencyOperation(db: SqlExecutor, operation: DependencyOperation, by: string | Actor): Promise<DependencyResult> {
  const caller = asActor(by);
  const actor = caller.id;
  if (operation.op === 'dependency_worklist') {
    const rows = await db.reads.all(issueQueries.dependencyWorklist, { state: operation.state, tool: operation.tool ?? null, project: operation.project ?? null, type: operation.type ?? null, priority: operation.priority ?? null, label: operation.label ?? null, after: operation.after === undefined ? '' : issueSortKey(operation.after), limit: operation.limit + 1 });
    const all = rows.map(issueRow); const issues = all.slice(0, operation.limit);
    return { issues, next_cursor: all.length > operation.limit ? issues.at(-1)?.id ?? null : null };
  }
  if (operation.op === 'dependency_list') {
    const result = await db.batch([
      { sql: 'SELECT revision FROM dependency_revisions WHERE dependent_id = ?', params: [operation.dependent_id] },
      { sql: 'SELECT issues.* FROM dependencies JOIN issues ON issues.id = dependencies.blocker_id WHERE dependent_id = ? AND sort_key > ? ORDER BY sort_key LIMIT ?', params: [operation.dependent_id, operation.after === undefined ? '' : issueSortKey(operation.after), operation.limit + 1] },
    ]);
    const row = rowsAt(result, 0)[0];
    if (!row) throw new PolylinedbError('not_found', 'Issue was not found', 404, { id: operation.dependent_id });
    const all = rowsAt(result, 1).map(issueRow); const blockers = all.slice(0, operation.limit).map(({ id, project, status }) => ({ id, project, status }));
    return { dependent_id: operation.dependent_id, revision: revision(row.revision), blockers, next_cursor: all.length > operation.limit ? blockers.at(-1)?.id ?? null : null };
  }
  if (!actor.trim() || /\p{Cc}/u.test(actor) || new TextEncoder().encode(actor).length > 256) return invalid('Invalid actor');
  const payload = JSON.stringify(operation);
  const present = 'EXISTS(SELECT 1 FROM dependencies WHERE dependent_id = ? AND blocker_id = ?)';
  const holds = agentHoldsClaim(operation.dependent_id, caller);
  const receipt: SqlStatement = { sql: `INSERT INTO dependency_requests(request_id,actor,payload,dependent_id,blocker_id,result_revision,outcome,created_at)
    SELECT ?,?,?,?,?,COALESCE((SELECT result_revision FROM dependency_requests WHERE request_id = ?),?),CASE WHEN ${present} THEN ? ELSE ? END,?
    WHERE EXISTS(SELECT 1 FROM dependency_requests WHERE request_id = ?) OR (
      EXISTS(SELECT 1 FROM issues WHERE id = ?) AND EXISTS(SELECT 1 FROM issues WHERE id = ?)
      AND EXISTS(SELECT 1 FROM dependency_revisions WHERE dependent_id = ? AND revision = ? AND revision < 9007199254740991) AND ${holds.sql})`,
    params: [operation.request_id, actor, payload, operation.dependent_id, operation.blocker_id, operation.request_id, operation.expected_revision + 1,
      operation.dependent_id, operation.blocker_id, operation.op === 'dependency_add' ? 'already_present' : 'removed', operation.op === 'dependency_add' ? 'added' : 'already_absent', new Date().toISOString(), operation.request_id, operation.dependent_id, operation.blocker_id, operation.dependent_id, operation.expected_revision, ...holds.params] };
  const admitted = 'EXISTS(SELECT 1 FROM dependency_requests WHERE request_id = ? AND dependent_id = ? AND result_revision = ?)';
  const gate = [operation.request_id, operation.dependent_id, operation.expected_revision + 1];
  let result;
  try {
    result = await db.batch([
      receipt,
      { sql: `UPDATE dependency_revisions SET revision = revision + 1 WHERE dependent_id = ? AND revision = ? AND ${admitted}`, params: [operation.dependent_id, operation.expected_revision, ...gate] },
      operation.op === 'dependency_add'
        ? { sql: `INSERT INTO dependencies(dependent_id,blocker_id) SELECT ?,? WHERE ${admitted} AND NOT ${present}`, params: [operation.dependent_id, operation.blocker_id, ...gate, operation.dependent_id, operation.blocker_id] }
        : { sql: `DELETE FROM dependencies WHERE dependent_id = ? AND blocker_id = ? AND ${admitted}`, params: [operation.dependent_id, operation.blocker_id, ...gate] },
      { sql: 'SELECT * FROM dependency_requests WHERE request_id = ?', params: [operation.request_id] },
      { sql: 'SELECT revision FROM dependency_revisions WHERE dependent_id = ?', params: [operation.dependent_id] },
      { sql: 'SELECT id FROM issues WHERE id = ?', params: [operation.blocker_id] },
      heldClaimObservation(operation.dependent_id),
      { sql: 'SELECT issues.* FROM dependencies JOIN issues ON issues.id = dependencies.blocker_id WHERE dependent_id = ? ORDER BY sort_key LIMIT 51', params: [operation.dependent_id] },
    ]);
  } catch (error) {
    if (knownError(error, 'dependency_cycle')) throw new PolylinedbError('dependency_cycle', 'The prerequisite would create a cycle', 409);
    if (!knownError(error, 'UNIQUE constraint failed: dependency_requests.request_id')) throw error;
    const replay = await db.batch([{ sql: 'SELECT * FROM dependency_requests WHERE request_id = ?', params: [operation.request_id] }]);
    const row = rowsAt(replay, 0)[0];
    if (!row) throw new PolylinedbError('storage_error', 'Committed dependency receipt is unavailable', 503);
    if (decideReplay(row, actor, payload) === 'request_conflict') throw new PolylinedbError('dependency_request_conflict', 'The request ID belongs to a different actor or payload', 409);
    return { dependency: dependencyReceipt(row) };
  }
  const request = rowsAt(result, 3)[0];
  if (request) return { dependency: dependencyReceipt(request) };
  const observed = rowsAt(result, 4)[0];
  if (observed) rejectAgentWrite(caller, 'issue_write', operation.dependent_id, [], rowsAt(result, 6)[0]);
  const edit = decidePrerequisiteEdit({ dependent_revision: observed ? revision(observed.revision) : null, blocker_exists: rowsAt(result, 5)[0] !== undefined }, operation.expected_revision);
  if (edit.accepted) throw new PolylinedbError('storage_error', 'The database rejected a prerequisite edit without a matching condition', 503);
  switch (edit.reason) {
    case 'dependent_not_found': throw new PolylinedbError('not_found', 'A dependency endpoint was not found', 404, { id: operation.dependent_id });
    case 'blocker_not_found': throw new PolylinedbError('not_found', 'A dependency endpoint was not found', 404, { id: operation.blocker_id });
    case 'revision_conflict': {
      const all = rowsAt(result, 7).map(issueRow); const blockers = all.slice(0, 50).map(({ id, project, status }) => ({ id, project, status }));
      throw new PolylinedbError('dependency_conflict', 'Read the current prerequisite revision before deciding on a new mutation', 409, { expected_revision: operation.expected_revision, current: { dependent_id: operation.dependent_id, revision: observed.revision, blockers, next_cursor: all.length > 50 ? blockers.at(-1)?.id ?? null : null } });
    }
    case 'revision_exhausted': throw new PolylinedbError('dependency_version_exhausted', 'The prerequisite revision cannot increase', 409, { dependent_id: operation.dependent_id });
    default: { const unreachable: never = edit.reason; return unreachable; }
  }
}
