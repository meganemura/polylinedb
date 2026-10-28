// Owns the land-order relation: which issue should land after which, its per-issue revision, and immutable receipts.
// Land order never blocks starting, claiming, or closing; the queue handoff only warns about it.
import { parseIssueId, parseRequestId } from '../store/issue-id.ts';
import { knownError, PolylinedbError, requireFields } from '../store/errors.ts';
import { recordingChanges } from '../store/changes-sql.ts';
import { mainWaitLabel } from '../claims/claim-handoff.ts';
import type { SqlExecutor, SqlStatement } from '../store/sql.ts';
import type { Status } from '../store/issue-record.ts';
import { decidePrerequisiteEdit, decideReplay, statuses } from '../../transition/index.ts';
import type { Actor } from '../../transition/index.ts';
import { agentHoldsClaim, asActor, heldClaimObservation, rejectAgentWrite } from '../claims/agent-gate.ts';

export type LandOrderMutation = { op: 'land_order_add' | 'land_order_remove'; later_id: string; earlier_id: string; expected_revision: number; request_id: string };
export type LandOrderOperation = LandOrderMutation | { op: 'land_order_list'; issue_id: string };
export type LandOrderOutcome = 'added' | 'already_present' | 'removed' | 'already_absent';
export type LandOrderReceipt = { later_id: string; earlier_id: string; revision: number; outcome: LandOrderOutcome };
export type LandOrderNeighbor = { id: string; project: string; status: Status };
/** `after` lists the issues this one lands after; `before` lists the issues that land after this one. */
export type LandOrder = { issue_id: string; revision: number; after: LandOrderNeighbor[]; before: LandOrderNeighbor[] };
export type LandOrderResult = { land_order_receipt: LandOrderReceipt } | LandOrder;
export type LandOrderEdge = { later_id: string; earlier_id: string };
export type LandOrderRevision = { later_id: string; revision: number };
export type LandOrderRequest = { request_id: string; actor: string; payload: string; later_id: string; earlier_id: string; result_revision: number; outcome: LandOrderOutcome; created_at: string };
export type LandOrderWarning = { id: string; status: Status };

const idSchema = { type: 'string', pattern: String.raw`^[a-z][a-z0-9]{0,15}-[1-9][0-9]*(\.[1-9][0-9]*){0,7}$` };
const mutationSchema = { type: 'object', additionalProperties: false, required: ['later_id', 'earlier_id', 'expected_revision', 'request_id'], properties: {
  later_id: { ...idSchema, description: 'The issue that should land later.' }, earlier_id: { ...idSchema, description: 'The issue that should land first.' },
  expected_revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: 'The land-order revision of later_id from land_order_list.' },
  request_id: { type: 'string', format: 'uuid', description: 'Reuse one lowercase UUID for each logical mutation.' },
} };
export const landOrderSchemas = {
  land_order_add: mutationSchema, land_order_remove: mutationSchema,
  land_order_list: { type: 'object', additionalProperties: false, required: ['issue_id'], properties: { issue_id: idSchema } },
};
const invalid = (message: string): never => { throw new PolylinedbError('invalid_input', message); };
function revision(value: unknown, name = 'expected_revision'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return invalid(`${name} must be a positive safe integer`);
  return value;
}
function identifier(value: unknown, label: string): string {
  try { return parseIssueId(value, label); } catch (error) { return invalid(error instanceof Error ? error.message : `Invalid ${label}`); }
}
export function parseLandOrderOperation(value: unknown): LandOrderOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return invalid('operation must be a plain object');
  const input = value as Record<string, unknown>;
  const op = input.op;
  if (op !== 'land_order_add' && op !== 'land_order_remove' && op !== 'land_order_list') return invalid('Unknown land-order operation');
  const schema = landOrderSchemas[op];
  requireFields(input, ['op', ...Object.keys(schema.properties)], ['op', ...schema.required]);
  if (op === 'land_order_list') return { op, issue_id: identifier(input.issue_id, 'issue_id') };
  let request_id: string;
  try { request_id = parseRequestId(input.request_id); } catch (error) { return invalid(error instanceof Error ? error.message : 'Invalid request_id'); }
  return { op, later_id: identifier(input.later_id, 'later_id'), earlier_id: identifier(input.earlier_id, 'earlier_id'), expected_revision: revision(input.expected_revision), request_id };
}
function outcome(value: unknown): LandOrderOutcome {
  if (value === 'added' || value === 'already_present' || value === 'removed' || value === 'already_absent') return value;
  throw new PolylinedbError('invalid_store', 'Invalid land-order outcome', 500);
}
function landOrderReceipt(row: Record<string, unknown>): LandOrderReceipt {
  return { later_id: parseIssueId(row.later_id), earlier_id: parseIssueId(row.earlier_id), revision: revision(row.result_revision), outcome: outcome(row.outcome) };
}
function neighbor(row: Record<string, unknown>): LandOrderNeighbor {
  const status = statuses.find(status => status === row.status);
  if (status === undefined || typeof row.project !== 'string' || !row.project) throw new PolylinedbError('invalid_store', 'Stored land-order issue is invalid', 500);
  return { id: parseIssueId(row.id), project: row.project, status };
}
function rowsAt(results: readonly { rows: readonly Record<string, unknown>[] }[], index: number) {
  const result = results[index];
  if (!result) throw new PolylinedbError('storage_error', 'Database omitted a land-order result', 503);
  return result.rows;
}

const neighbors = (column: 'later_id' | 'earlier_id', ids: string): string => {
  const other = column === 'later_id' ? 'earlier_id' : 'later_id';
  return `SELECT land_order.${column} AS issue_id, issues.id, issues.project, issues.status FROM land_order JOIN issues ON issues.id = land_order.${other}
    WHERE land_order.${column} IN (SELECT value FROM json_each(${ids})) ORDER BY issues.sort_key`;
};
function landOrderReads(ids: readonly string[]): SqlStatement[] {
  const json = JSON.stringify(ids);
  return [
    { sql: `SELECT issues.id, COALESCE(land_order_revisions.revision, 1) AS revision FROM issues LEFT JOIN land_order_revisions ON land_order_revisions.later_id = issues.id
      WHERE issues.id IN (SELECT value FROM json_each(?))`, params: [json] },
    { sql: neighbors('later_id', '?'), params: [json] },
    { sql: neighbors('earlier_id', '?'), params: [json] },
  ];
}
function landOrders(results: readonly { rows: readonly Record<string, unknown>[] }[], offset: number): Map<string, LandOrder> {
  const orders = new Map<string, LandOrder>();
  for (const row of rowsAt(results, offset)) {
    const issue_id = parseIssueId(row.id);
    orders.set(issue_id, { issue_id, revision: revision(row.revision, 'revision'), after: [], before: [] });
  }
  for (const [index, side] of [[offset + 1, 'after'], [offset + 2, 'before']] as const) {
    for (const row of rowsAt(results, index)) orders.get(parseIssueId(row.issue_id))?.[side].push(neighbor(row));
  }
  return orders;
}

/** Reads the land order of each issue in one consistent read; a missing issue has no entry. */
export async function readLandOrders(db: SqlExecutor, ids: readonly string[]): Promise<Map<string, LandOrder>> {
  if (ids.length === 0) return new Map();
  return landOrders(await db.batch(landOrderReads(ids)), 0);
}

/** Names each direct predecessor that has not reached the landing queue: it is neither closed nor labeled main-wait. */
export async function landOrderWarnings(db: SqlExecutor, issueId: string): Promise<LandOrderWarning[]> {
  const rows = await db.batch([{ sql: `SELECT issues.id, issues.project, issues.status FROM land_order JOIN issues ON issues.id = land_order.earlier_id
    WHERE land_order.later_id = ? AND issues.status <> 'closed' AND NOT EXISTS(SELECT 1 FROM json_each(issues.labels_json) AS label WHERE label.value = ?)
    ORDER BY issues.sort_key`, params: [issueId, mainWaitLabel] }]);
  return rowsAt(rows, 0).map(neighbor).map(({ id, status }) => ({ id, status }));
}

export async function executeLandOrderOperation(db: SqlExecutor, operation: LandOrderOperation, by: string | Actor): Promise<LandOrderResult> {
  const caller = asActor(by);
  const actor = caller.id;
  if (operation.op === 'land_order_list') {
    const found = (await readLandOrders(db, [operation.issue_id])).get(operation.issue_id);
    if (!found) throw new PolylinedbError('not_found', 'Issue was not found', 404, { id: operation.issue_id });
    return found;
  }
  if (!actor.trim() || /\p{Cc}/u.test(actor) || new TextEncoder().encode(actor).length > 256) return invalid('Invalid actor');
  const payload = JSON.stringify(operation);
  const { later_id, earlier_id, expected_revision, request_id } = operation;
  const present = 'EXISTS(SELECT 1 FROM land_order WHERE later_id = ? AND earlier_id = ?)';
  const current = 'COALESCE((SELECT revision FROM land_order_revisions WHERE later_id = ?), 1)';
  const holds = agentHoldsClaim(later_id, caller);
  const adding = operation.op === 'land_order_add';
  const receipt: SqlStatement = { sql: `INSERT INTO land_order_requests(request_id,actor,payload,later_id,earlier_id,result_revision,outcome,created_at)
    SELECT ?,?,?,?,?,?,CASE WHEN ${present} THEN ? ELSE ? END,?
    WHERE EXISTS(SELECT 1 FROM land_order_requests WHERE request_id = ?) OR (
      EXISTS(SELECT 1 FROM issues WHERE id = ?) AND EXISTS(SELECT 1 FROM issues WHERE id = ?)
      AND ${current} = ? AND ${current} < 9007199254740991 AND ${holds.sql})`,
  params: [request_id, actor, payload, later_id, earlier_id, expected_revision + 1, later_id, earlier_id, adding ? 'already_present' : 'removed', adding ? 'added' : 'already_absent',
    new Date().toISOString(), request_id, later_id, earlier_id, later_id, expected_revision, later_id, ...holds.params] };
  const admitted = 'EXISTS(SELECT 1 FROM land_order_requests WHERE request_id = ? AND later_id = ? AND result_revision = ?)';
  const gate = [request_id, later_id, expected_revision + 1];
  let result;
  try {
    result = await recordingChanges(db, actor).batch([
      receipt,
      { sql: `INSERT INTO land_order_revisions(later_id,revision) SELECT ?,? WHERE ${admitted}
        ON CONFLICT(later_id) DO UPDATE SET revision = excluded.revision`, params: [later_id, expected_revision + 1, ...gate] },
      adding
        ? { sql: `INSERT INTO land_order(later_id,earlier_id) SELECT ?,? WHERE ${admitted} AND NOT ${present}`, params: [later_id, earlier_id, ...gate, later_id, earlier_id] }
        : { sql: `DELETE FROM land_order WHERE later_id = ? AND earlier_id = ? AND ${admitted}`, params: [later_id, earlier_id, ...gate] },
      { sql: 'SELECT * FROM land_order_requests WHERE request_id = ?', params: [request_id] },
      { sql: `SELECT ${current} AS revision FROM issues WHERE id = ?`, params: [later_id, later_id] },
      { sql: 'SELECT id FROM issues WHERE id = ?', params: [earlier_id] },
      heldClaimObservation(later_id),
      ...landOrderReads([later_id]),
    ]);
  } catch (error) {
    if (knownError(error, 'dependency_cycle')) throw new PolylinedbError('dependency_cycle', 'The land order would create a cycle through prerequisites or land order', 409);
    if (!knownError(error, 'UNIQUE constraint failed: land_order_requests.request_id')) throw error;
    const replay = await db.batch([{ sql: 'SELECT * FROM land_order_requests WHERE request_id = ?', params: [request_id] }]);
    const row = rowsAt(replay, 0)[0];
    if (!row) throw new PolylinedbError('storage_error', 'Committed land-order receipt is unavailable', 503);
    if (decideReplay(row, actor, payload) === 'request_conflict') throw new PolylinedbError('land_order_request_conflict', 'The request ID belongs to a different actor or payload', 409);
    return { land_order_receipt: landOrderReceipt(row) };
  }
  const request = rowsAt(result, 3)[0];
  if (request) return { land_order_receipt: landOrderReceipt(request) };
  const observed = rowsAt(result, 4)[0];
  if (observed) rejectAgentWrite(caller, 'issue_write', later_id, [], rowsAt(result, 6)[0]);
  // The land order has the same shape as a prerequisite edit: one revision on the later issue, and an endpoint that must exist.
  const edit = decidePrerequisiteEdit({ dependent_revision: observed ? revision(observed.revision, 'revision') : null, blocker_exists: rowsAt(result, 5)[0] !== undefined }, expected_revision);
  if (edit.accepted) throw new PolylinedbError('storage_error', 'The database rejected a land-order edit without a matching condition', 503);
  switch (edit.reason) {
    case 'dependent_not_found': throw new PolylinedbError('not_found', 'A land-order endpoint was not found', 404, { id: later_id });
    case 'blocker_not_found': throw new PolylinedbError('not_found', 'A land-order endpoint was not found', 404, { id: earlier_id });
    case 'revision_conflict': {
      const current = landOrders(result, 7).get(later_id);
      throw new PolylinedbError('land_order_conflict', 'Read the current land-order revision before deciding on a new mutation', 409, { expected_revision, current });
    }
    case 'revision_exhausted': throw new PolylinedbError('land_order_version_exhausted', 'The land-order revision cannot increase', 409, { later_id });
    default: { const unreachable: never = edit.reason; return unreachable; }
  }
}
