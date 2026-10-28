// Owns external resources recorded on an issue: entries, marks, the per-issue revision, and immutable receipts.
// An entry holds identifiers only. The close guard that reads live entries belongs to issue updates.
import { parseIssueId, parseRequestId, issueSortKey } from './issue-id.ts';
import { knownError, PolylinedbError, requireFields } from './errors.ts';
import { recordingChanges } from './changes-sql.ts';
import { claimProofSchema, parseClaimProof } from './claims.ts';
import { claimProofPredicate } from './claims-sql.ts';
import type { ClaimProof } from './claims-sql.ts';
import type { SqlExecutor, SqlStatement } from './sql.ts';
import type { Status } from './issue-record.ts';
import { decideReplay, decideResourceAddition, decideResourceUpdate, resourceMarks, resourceState, statuses } from '../transition/index.ts';
import type { Actor, ResourceDecision, ResourceMark, ResourceState } from '../transition/index.ts';
import { agentHoldsClaim, asActor, heldClaimObservation, rejectAgentWrite } from './agent-gate.ts';

export type ResourceAdd = { op: 'resource_add'; issue_id: string; kind: string; name: string; expected_revision: number; request_id: string };
export type ResourceUpdate = { op: 'resource_update'; issue_id: string; seq: number; expected_revision: number; request_id: string;
  external_id?: string; mark?: ResourceMark; evidence?: string; claim_proof?: ClaimProof };
export type ResourceOperation = ResourceAdd | ResourceUpdate | { op: 'resource_list'; issue_id: string }
  | { op: 'resource_live'; tool?: string; project?: string; after?: string; limit: number };
/** One stored entry, with exactly the columns of its row. */
export type ResourceEntry = { issue_id: string; seq: number; kind: string; name: string; external_id: string | null;
  created_at: string | null; deleted_at: string | null; verified_deleted_at: string | null; verified_by: string | null; evidence: string | null;
  added_at: string; added_by: string };
export type Resource = ResourceEntry & { state: ResourceState };
export type ResourceOutcome = 'added' | 'updated';
export type ResourceReceipt = { issue_id: string; seq: number; revision: number; outcome: ResourceOutcome };
export type ResourceList = { issue_id: string; revision: number; resources: Resource[] };
export type LiveResources = { issue: { id: string; project: string; status: Status }; resources: Resource[] };
export type ResourceResult = { resource_receipt: ResourceReceipt } | ResourceList | { entries: LiveResources[]; next_cursor: string | null };
export type ResourceRevision = { issue_id: string; revision: number };
export type ResourceRequest = { request_id: string; actor: string; payload: string; issue_id: string; seq: number; result_revision: number; outcome: ResourceOutcome; created_at: string };

export const resourceKindPattern = /^[a-z0-9][a-z0-9:._-]{0,63}$/;
const idSchema = { type: 'string', pattern: String.raw`^[a-z][a-z0-9]{0,15}-[1-9][0-9]*(\.[1-9][0-9]*){0,7}$` };
const identifierText = 'An identifier only, at most 256 UTF-8 bytes, without whitespace or control characters. Never a secret, token, connection string, or URL with credentials.';
const revisionSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: 'The resource revision of the issue from resource_list.' };
const requestSchema = { type: 'string', format: 'uuid', description: 'Reuse one lowercase UUID for each logical mutation.' };
export const resourceSchemas = {
  resource_add: { type: 'object', additionalProperties: false, required: ['issue_id', 'kind', 'name', 'expected_revision', 'request_id'], properties: {
    issue_id: idSchema, kind: { type: 'string', pattern: resourceKindPattern.source, description: 'Free-form resource kind, such as d1:database or worker.' },
    name: { type: 'string', minLength: 1, maxLength: 256, description: identifierText }, expected_revision: revisionSchema, request_id: requestSchema,
  } },
  resource_update: { type: 'object', additionalProperties: false, required: ['issue_id', 'seq', 'expected_revision', 'request_id'], properties: {
    issue_id: idSchema, seq: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, expected_revision: revisionSchema, request_id: requestSchema,
    external_id: { type: 'string', minLength: 1, maxLength: 256, description: `Set once. ${identifierText}` },
    mark: { type: 'string', enum: resourceMarks, description: 'Marks move forward only: planned, created, deleted, verified_deleted; or planned straight to verified_deleted.' },
    evidence: { type: 'string', minLength: 1, maxLength: 1024, description: 'Required with mark verified_deleted: how the deletion was checked, at most 1024 UTF-8 bytes. No secrets.' },
    claim_proof: { ...claimProofSchema, description: 'Required with mark verified_deleted: a current claim proof on this issue.' },
  } },
  resource_list: { type: 'object', additionalProperties: false, required: ['issue_id'], properties: { issue_id: idSchema } },
  resource_live: { type: 'object', additionalProperties: false, required: [], properties: {
    tool: { type: 'string', minLength: 1, maxLength: 256 }, project: { type: 'string', minLength: 1, maxLength: 256 }, after: idSchema,
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  } },
};

const invalid = (message: string): never => { throw new PolylinedbError('invalid_input', message); };
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return invalid('operation must be a plain object');
  return value as Record<string, unknown>;
}
function counter(value: unknown, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > maximum) return invalid(`${name} must be an integer from 1 through ${maximum}`);
  return value;
}
const utf8 = (value: string) => new TextEncoder().encode(value).length;
export function parseResourceKind(value: unknown): string {
  if (typeof value !== 'string' || !resourceKindPattern.test(value)) return invalid('kind must match ^[a-z0-9][a-z0-9:._-]{0,63}$');
  return value;
}
export function parseResourceIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || utf8(value) > 256 || /[\s\p{Cc}]/u.test(value)) return invalid(`${name} must be 1 through 256 UTF-8 bytes without whitespace or control characters`);
  return value;
}
export function parseResourceEvidence(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || utf8(value) > 1024 || value.includes('\u0000')) return invalid('evidence must be a nonempty string of at most 1024 UTF-8 bytes');
  return value;
}
function name(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /\p{Cc}/u.test(value) || utf8(value) > 256) return invalid(`Invalid ${label}`);
  return value;
}
function identifier(value: unknown, label: string): string {
  try { return parseIssueId(value, label); } catch (error) { return invalid(error instanceof Error ? error.message : `Invalid ${label}`); }
}
function requestId(value: unknown): string {
  try { return parseRequestId(value); } catch (error) { return invalid(error instanceof Error ? error.message : 'Invalid request_id'); }
}

export function parseResourceOperation(value: unknown): ResourceOperation {
  const input = plain(value);
  const op = input.op;
  if (op !== 'resource_add' && op !== 'resource_update' && op !== 'resource_list' && op !== 'resource_live') return invalid('Unknown resource operation');
  const schema = resourceSchemas[op];
  requireFields(input, ['op', ...Object.keys(schema.properties)], ['op', ...schema.required]);
  if (op === 'resource_live') return { op, limit: input.limit === undefined ? 50 : counter(input.limit, 'limit', 100),
    ...(input.tool === undefined ? {} : { tool: name(input.tool, 'tool') }), ...(input.project === undefined ? {} : { project: name(input.project, 'project') }),
    ...(input.after === undefined ? {} : { after: identifier(input.after, 'after') }) };
  const issue_id = identifier(input.issue_id, 'issue_id');
  if (op === 'resource_list') return { op, issue_id };
  const expected_revision = counter(input.expected_revision, 'expected_revision');
  const request_id = requestId(input.request_id);
  if (op === 'resource_add') return { op, issue_id, kind: parseResourceKind(input.kind), name: parseResourceIdentifier(input.name, 'name'), expected_revision, request_id };
  const mark = input.mark === undefined ? undefined : resourceMarks.find(mark => mark === input.mark) ?? invalid(`mark must be one of ${resourceMarks.join(', ')}`);
  if (input.external_id === undefined && mark === undefined) return invalid('resource_update needs external_id, mark, or both');
  if ((input.evidence !== undefined || input.claim_proof !== undefined) !== (mark === 'verified_deleted')) return invalid('evidence and claim_proof are accepted only with mark verified_deleted, which requires both');
  if (mark === 'verified_deleted' && (input.evidence === undefined || input.claim_proof === undefined)) return invalid('mark verified_deleted requires evidence and claim_proof');
  return { op, issue_id, seq: counter(input.seq, 'seq'), expected_revision, request_id,
    ...(input.external_id === undefined ? {} : { external_id: parseResourceIdentifier(input.external_id, 'external_id') }),
    ...(mark === undefined ? {} : { mark }),
    ...(input.evidence === undefined ? {} : { evidence: parseResourceEvidence(input.evidence) }),
    ...(input.claim_proof === undefined ? {} : { claim_proof: parseClaimProof(input.claim_proof, issue_id) }) };
}

const nullableText = (value: unknown, label: string): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string' || !value) throw new Error(`${label} is not text`);
  return value;
};
/** Decodes a stored entry; it rejects marks that skip a step, so every stored entry has a state. */
export function resourceEntry(row: Record<string, unknown>): ResourceEntry {
  try {
    const entry: ResourceEntry = { issue_id: parseIssueId(row.issue_id), seq: counter(row.seq, 'seq'), kind: parseResourceKind(row.kind), name: parseResourceIdentifier(row.name, 'name'),
      external_id: row.external_id === null ? null : parseResourceIdentifier(row.external_id, 'external_id'),
      created_at: nullableText(row.created_at, 'created_at'), deleted_at: nullableText(row.deleted_at, 'deleted_at'), verified_deleted_at: nullableText(row.verified_deleted_at, 'verified_deleted_at'),
      verified_by: row.verified_by === null ? null : name(row.verified_by, 'verified_by'), evidence: row.evidence === null ? null : parseResourceEvidence(row.evidence),
      added_at: String(nullableText(row.added_at, 'added_at')), added_by: name(row.added_by, 'added_by') };
    if (entry.deleted_at !== null && entry.created_at === null) throw new Error('a deleted entry must have been created');
    if (entry.verified_deleted_at !== null && entry.created_at !== null && entry.deleted_at === null) throw new Error('a created entry must be deleted before its deletion is verified');
    if ((entry.verified_deleted_at === null) !== (entry.verified_by === null) || (entry.verified_deleted_at === null) !== (entry.evidence === null)) throw new Error('a verified deletion needs its actor and evidence');
    return entry;
  } catch (error) {
    throw new PolylinedbError('invalid_store', `Stored resource is invalid: ${error instanceof Error ? error.message : 'invalid row'}`, 500);
  }
}
/** Decodes a stored entry and derives its state from the marks. */
export function resourceRow(row: Record<string, unknown>): Resource {
  const entry = resourceEntry(row);
  return { ...entry, state: resourceState(entry) };
}
function outcome(value: unknown): ResourceOutcome {
  if (value === 'added' || value === 'updated') return value;
  throw new PolylinedbError('invalid_store', 'Invalid resource outcome', 500);
}
function receipt(row: Record<string, unknown>): ResourceReceipt {
  try { return { issue_id: parseIssueId(row.issue_id), seq: counter(row.seq, 'seq'), revision: counter(row.result_revision, 'result_revision'), outcome: outcome(row.outcome) }; }
  catch (error) { if (error instanceof PolylinedbError && error.status === 500) throw error; throw new PolylinedbError('invalid_store', 'Invalid resource receipt', 500); }
}
function rowsAt(results: readonly { rows: readonly Record<string, unknown>[] }[], index: number) {
  const result = results[index];
  if (!result) throw new PolylinedbError('storage_error', 'Database omitted a resource result', 503);
  return result.rows;
}

const live = 'verified_deleted_at IS NULL';
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const currentRevision = 'COALESCE((SELECT revision FROM resource_revisions WHERE issue_id = ?), 1)';
function listReads(issueId: string): SqlStatement[] {
  return [
    { sql: `SELECT ${currentRevision} AS revision FROM issues WHERE id = ?`, params: [issueId, issueId] },
    { sql: 'SELECT * FROM issue_resources WHERE issue_id = ? ORDER BY seq', params: [issueId] },
  ];
}
function listFrom(results: readonly { rows: readonly Record<string, unknown>[] }[], offset: number, issueId: string): ResourceList | null {
  const row = rowsAt(results, offset)[0];
  if (!row) return null;
  return { issue_id: issueId, revision: counter(row.revision, 'revision'), resources: rowsAt(results, offset + 1).map(resourceRow) };
}

// The SQL form of the forward-only rule, which decideResourceUpdate names when the write does not commit.
function markAllowed(mark: ResourceMark | undefined): string {
  switch (mark) {
    case undefined: return '1';
    case 'created': return 'created_at IS NULL AND deleted_at IS NULL';
    case 'deleted': return 'created_at IS NOT NULL AND deleted_at IS NULL';
    case 'verified_deleted': return '(deleted_at IS NOT NULL OR created_at IS NULL)';
    default: { const unreachable: never = mark; return unreachable; }
  }
}

export async function executeResourceOperation(db: SqlExecutor, operation: ResourceOperation, by: string | Actor): Promise<ResourceResult> {
  const caller = asActor(by);
  const actor = caller.id;
  if (operation.op === 'resource_list') {
    const found = listFrom(await db.batch(listReads(operation.issue_id)), 0, operation.issue_id);
    if (!found) throw new PolylinedbError('not_found', 'Issue was not found', 404, { id: operation.issue_id });
    return found;
  }
  if (operation.op === 'resource_live') {
    const [issues] = await db.batch([{ sql: `SELECT issues.id, issues.project, issues.status FROM issues
      WHERE (? IS NULL OR issues.tool = ?) AND (? IS NULL OR issues.project = ?) AND issues.sort_key > ?
      AND EXISTS(SELECT 1 FROM issue_resources WHERE issue_resources.issue_id = issues.id AND issue_resources.${live})
      ORDER BY issues.sort_key LIMIT ?`, params: [operation.tool ?? null, operation.tool ?? null, operation.project ?? null, operation.project ?? null,
      operation.after === undefined ? '' : issueSortKey(operation.after), operation.limit + 1] }]);
    const found = (issues?.rows ?? []).map(row => {
      const status = statuses.find(status => status === row.status);
      if (status === undefined || typeof row.project !== 'string') throw new PolylinedbError('invalid_store', 'Stored issue is invalid', 500);
      return { id: parseIssueId(row.id), project: row.project, status };
    });
    const page = found.slice(0, operation.limit);
    const [entries] = page.length === 0 ? [undefined] : await db.batch([{ sql: `SELECT * FROM issue_resources WHERE issue_id IN (SELECT value FROM json_each(?)) AND ${live} ORDER BY seq`, params: [JSON.stringify(page.map(issue => issue.id))] }]);
    const byIssue = new Map(page.map(issue => [issue.id, [] as Resource[]]));
    for (const row of entries?.rows ?? []) byIssue.get(parseIssueId(row.issue_id))?.push(resourceRow(row));
    return { entries: page.map(issue => ({ issue, resources: byIssue.get(issue.id) ?? [] })), next_cursor: found.length > operation.limit ? page.at(-1)?.id ?? null : null };
  }
  name(actor, 'actor');
  const payload = JSON.stringify(operation);
  const { issue_id, expected_revision, request_id } = operation;
  const holds = agentHoldsClaim(issue_id, caller);
  const proof = operation.op === 'resource_update' && operation.claim_proof ? claimProofPredicate(operation.claim_proof, actor) : { sql: '1', params: [] };
  const entry = operation.op === 'resource_update'
    ? { sql: `EXISTS(SELECT 1 FROM issue_resources WHERE issue_id = ? AND seq = ? AND ${live} AND ${markAllowed(operation.mark)} AND (? IS NULL OR external_id IS NULL OR external_id = ?))`,
      params: [issue_id, operation.seq, operation.external_id ?? null, operation.external_id ?? null] }
    : { sql: '1', params: [] };
  const seq = operation.op === 'resource_add' ? { sql: 'COALESCE((SELECT MAX(seq) FROM issue_resources WHERE issue_id = ?), 0) + 1', params: [issue_id] } : { sql: '?', params: [operation.seq] };
  const admission: SqlStatement = { sql: `INSERT INTO resource_requests(request_id,actor,payload,issue_id,seq,result_revision,outcome,created_at)
    SELECT ?,?,?,?,${seq.sql},?,?,${now}
    WHERE EXISTS(SELECT 1 FROM resource_requests WHERE request_id = ?) OR (
      EXISTS(SELECT 1 FROM issues WHERE id = ?) AND ${currentRevision} = ? AND ${currentRevision} < 9007199254740991
      AND ${holds.sql} AND ${proof.sql} AND ${entry.sql})`,
  params: [request_id, actor, payload, issue_id, ...seq.params, expected_revision + 1, operation.op === 'resource_add' ? 'added' : 'updated',
    request_id, issue_id, issue_id, expected_revision, issue_id, ...holds.params, ...proof.params, ...entry.params] };
  const admitted = 'EXISTS(SELECT 1 FROM resource_requests WHERE request_id = ? AND issue_id = ? AND result_revision = ?)';
  const gate = [request_id, issue_id, expected_revision + 1];
  const markedAt = '(SELECT created_at FROM resource_requests WHERE request_id = ?)';
  const write: SqlStatement = operation.op === 'resource_add'
    ? { sql: `INSERT INTO issue_resources(issue_id,seq,kind,name,added_at,added_by) SELECT issue_id,seq,?,?,created_at,actor FROM resource_requests WHERE request_id = ? AND ${admitted}`,
      params: [operation.kind, operation.name, request_id, ...gate] }
    : { sql: `UPDATE issue_resources SET external_id = COALESCE(external_id, ?),
        created_at = CASE WHEN ? = 'created' THEN ${markedAt} ELSE created_at END,
        deleted_at = CASE WHEN ? = 'deleted' THEN ${markedAt} ELSE deleted_at END,
        verified_deleted_at = CASE WHEN ? = 'verified_deleted' THEN ${markedAt} ELSE verified_deleted_at END,
        verified_by = CASE WHEN ? = 'verified_deleted' THEN ? ELSE verified_by END,
        evidence = CASE WHEN ? = 'verified_deleted' THEN ? ELSE evidence END
        WHERE issue_id = ? AND seq = ? AND ${admitted}`,
    params: [operation.external_id ?? null, operation.mark ?? null, request_id, operation.mark ?? null, request_id, operation.mark ?? null, request_id,
      operation.mark ?? null, actor, operation.mark ?? null, operation.evidence ?? null, issue_id, operation.seq, ...gate] };
  let result;
  try {
    result = await recordingChanges(db, actor).batch([
      admission,
      { sql: `INSERT INTO resource_revisions(issue_id,revision) SELECT ?,? WHERE ${admitted}
        ON CONFLICT(issue_id) DO UPDATE SET revision = excluded.revision`, params: [issue_id, expected_revision + 1, ...gate] },
      write,
      { sql: 'SELECT * FROM resource_requests WHERE request_id = ?', params: [request_id] },
      heldClaimObservation(issue_id),
      ...(operation.op === 'resource_update' && operation.claim_proof ? [{ sql: `SELECT ${proof.sql} AS holds`, params: [...proof.params] }] : []),
      ...listReads(issue_id),
    ]);
  } catch (error) {
    if (!knownError(error, 'UNIQUE constraint failed: resource_requests.request_id')) throw error;
    const replay = await db.batch([{ sql: 'SELECT * FROM resource_requests WHERE request_id = ?', params: [request_id] }]);
    const row = rowsAt(replay, 0)[0];
    if (!row) throw new PolylinedbError('storage_error', 'Committed resource receipt is unavailable', 503);
    if (decideReplay(row, actor, payload) === 'request_conflict') throw new PolylinedbError('resource_request_conflict', 'The request ID belongs to a different actor or payload', 409);
    return { resource_receipt: receipt(row) };
  }
  const stored = rowsAt(result, 3)[0];
  if (stored) return { resource_receipt: receipt(stored) };
  const listAt = operation.op === 'resource_update' && operation.claim_proof ? 6 : 5;
  const current = listFrom(result, listAt, issue_id);
  if (current) rejectAgentWrite(caller, 'issue_write', issue_id, [], rowsAt(result, 4)[0]);
  if (current && operation.op === 'resource_update' && operation.claim_proof && rowsAt(result, 5)[0]?.holds !== 1) {
    throw new PolylinedbError('claim_required', 'Marking verified_deleted needs a current claim proof on this issue', 409, { id: issue_id });
  }
  const target = operation.op === 'resource_update' ? current?.resources.find(entry => entry.seq === operation.seq) ?? null : null;
  const decision: ResourceDecision = operation.op === 'resource_add'
    ? decideResourceAddition(current?.revision ?? null, expected_revision)
    : decideResourceUpdate(current?.revision ?? null, target, { ...(operation.mark === undefined ? {} : { mark: operation.mark }), ...(operation.external_id === undefined ? {} : { external_id: operation.external_id }) }, expected_revision);
  if (decision.accepted) throw new PolylinedbError('storage_error', 'The database rejected a resource write without a matching condition', 503);
  switch (decision.reason) {
    case 'issue_not_found': throw new PolylinedbError('not_found', 'Issue was not found', 404, { id: issue_id });
    case 'entry_not_found': throw new PolylinedbError('not_found', 'The resource entry was not found on this issue', 404, { id: issue_id });
    case 'revision_conflict': throw new PolylinedbError('resource_conflict', 'Read the current resource revision before deciding on a new mutation', 409, { expected_revision, current });
    case 'revision_exhausted': throw new PolylinedbError('resource_version_exhausted', 'The resource revision cannot increase', 409, { issue_id });
    case 'entry_settled': throw new PolylinedbError('resource_mark_rejected', 'The resource deletion is already verified; the entry cannot change', 409, { resource: target });
    case 'mark_not_forward': throw new PolylinedbError('resource_mark_rejected', 'Marks move forward only: planned, created, deleted, verified_deleted, or planned straight to verified_deleted', 409, { resource: target });
    case 'external_id_set': throw new PolylinedbError('resource_mark_rejected', 'The external_id is already set to a different value', 409, { resource: target });
    default: { const unreachable: never = decision.reason; return unreachable; }
  }
}
