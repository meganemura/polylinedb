// Owns issue operations and atomic SQL; transports and connection lifetimes stay outside.
import { parseIssueId, issueSortKey, parsePrefix, parseRequestId } from "../store/issue-id.ts";
import type { Database } from 'solarsql';
import { issueQueries } from "../store/issue-queries.ts";
import { expectedType, PolylinedbError, requireFields } from '../store/errors.ts';
import { claimProofSchema, claimRow, inspectClaim, parseClaimProof, parseIncarnation } from '../claims/claims.ts';
import type { ClaimDisplay } from '../claims/claims.ts';
import type { ClaimInspection } from '../claims/claims.ts';
import { claimState, decideCommentEdit, decideCreation, decideIssueUpdate, decideReply, decideReplay, fields, issueTypes, startedWorkNeedsClaim, statuses } from '../../transition/index.ts';
import type { Actor } from '../../transition/index.ts';
import { agentHoldsClaim, asActor, heldClaimObservation, rejectAgentWrite } from '../claims/agent-gate.ts';
import { issueClaimGuard } from '../claims/claims-sql.ts';
import { recordingChanges } from '../store/changes-sql.ts';
import { activeBlockerExists } from '../store/active-blocker.ts';
import { liveResourceSummary, shownLiveResources } from '../resources/resources-sql.ts';
import type { ClaimProof } from '../claims/claims-sql.ts';
import { enumeration, handleSchema, id, integer, invalid, issueRow, labels, name, object, parseHandle, parseVia, shownCommentRow, starrerNames, storedCommentRow, text, validated } from '../store/issue-record.ts';
import type { Comment, Field, Issue, IssueType, Status, Values } from '../store/issue-record.ts';
import type { SqlExecutor, SqlStatement } from '../store/sql.ts';

export type Change = { [K in Field]: { field: K; value: Values[K]; expected: number } }[Field];
type Filters = { tool?: string; project?: string; status?: Status; type?: IssueType;
  priority?: number; label?: string; after?: string; limit: number };
// What a post declares about itself; each part is optional, and none of them authorizes anything.
type Voice = { handle: string; via: string; reply_to: string };
type StatusOverride = ({ force?: never; reason?: never } | { force: true; reason: string }) & { resources_reason?: string };
export type Operation =
  | ({ op: 'create'; prefix: string; request_id: string; parent?: string } & Values)
  | { op: 'show'; id: string; with_land_order?: true }
  | ({ op: 'list'; claimed?: boolean; with_land_order?: true } & Filters)
  | ({ op: 'search'; query: string; with_matches?: true } & Filters)
  | ({ op: 'comment'; id: string; body: string } & Partial<Voice>)
  | { op: 'comment_edit'; id: string; comment_id: string; body: string; expected: number }
  | ({ op: 'update'; id: string; changes: [Change, ...Change[]]; claim_proof?: ClaimProof } & StatusOverride)
  | ({ op: 'close'; id: string; expected: number; claim_proof?: ClaimProof } & StatusOverride)
  | { op: 'reopen'; id: string; expected: number; claim_proof?: ClaimProof }
  | { op: 'actor' };
export type SearchMatch = { issue_id: string; excerpt: string } & ({ location: 'body' } | { location: 'comment'; comment_id: string });
export type OperationResult = { issue: Issue } | { issue: Issue; comments: Comment[]; claim: ClaimInspection }
  | { issues: Issue[]; next_cursor: string | null } | { issues: Issue[]; next_cursor: string | null; matches: SearchMatch[] }
  | { comment: Comment } | { actor: string };


const nameSchema = { type: 'string', minLength: 1, maxLength: 256, description: 'At most 256 UTF-8 bytes, without control characters.' };
const bodySchema = { type: 'string', minLength: 1, maxLength: 65536, description: 'At most 65536 UTF-8 bytes.' };
const reasonSchema = { ...bodySchema, description: 'Accepted only with force: true. At most 65536 UTF-8 bytes.' };
const resourcesReasonSchema = { ...bodySchema, description: 'Close although external resources on the issue are not verified deleted. Stored as a comment. force does not replace it. At most 65536 UTF-8 bytes.' };
const versionSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const idSchema = { type: 'string', pattern: String.raw`^[a-z][a-z0-9]{0,15}-[1-9][0-9]*(\.[1-9][0-9]*){0,7}$` };
const fieldRegistry = {
  tool: { column: 'tool', parse: (value: unknown) => name(value, 'tool'), schema: nameSchema },
  project: { column: 'project', parse: (value: unknown) => name(value, 'project'), schema: nameSchema },
  body: { column: 'body', parse: (value: unknown) => text(value, 'body'), schema: bodySchema },
  status: { column: 'status', parse: (value: unknown) => enumeration(value, 'status', statuses), schema: { type: 'string', enum: statuses } },
  type: { column: 'type', parse: (value: unknown) => enumeration(value, 'type', issueTypes), schema: { type: 'string', enum: issueTypes } },
  priority: { column: 'priority', parse: (value: unknown) => integer(value, 'priority', 0, 4), schema: { type: 'integer', minimum: 0, maximum: 4 } },
  labels: { column: 'labels_json', parse: labels, schema: { type: 'array', maxItems: 64, items: nameSchema } },
};
const voiceSchemas = {
  handle: handleSchema,
  via: { type: 'string', minLength: 1, maxLength: 128, description: 'What produced this one post, such as a host, a model, and a place. At most 128 UTF-8 bytes, without control characters. Attribution only.' },
  reply_to: { type: 'string', format: 'uuid', description: 'The ID of a comment on the same issue that this comment answers.' },
};
const withLandOrderSchema = { const: true, description: 'Also return land_order: which issues this one lands after and before. It never blocks work.' };
const objectSchema = (properties: Record<string, unknown>, required: readonly string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const valueSchemas = Object.fromEntries(fields.map((field) => [field, fieldRegistry[field].schema]));
const filterSchemas = { tool: nameSchema, project: nameSchema, status: fieldRegistry.status.schema,
  type: fieldRegistry.type.schema, priority: fieldRegistry.priority.schema, label: nameSchema,
  after: idSchema, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } };
export const operationSchemas = {
  create: objectSchema({ ...valueSchemas, parent: idSchema, prefix: { type: 'string', pattern: '^[a-z][a-z0-9]{0,15}$' }, request_id: { type: 'string', format: 'uuid', description: 'Generate one lowercase UUID per logical creation. Retain it and reuse it unchanged on an explicit retry.' } }, ['tool', 'project', 'body', 'prefix', 'request_id']),
  show: objectSchema({ id: idSchema, with_land_order: withLandOrderSchema }, ['id']),
  list: objectSchema({ ...filterSchemas, claimed: { type: 'boolean', description: 'true keeps issues with an active claim; false keeps issues whose claim is never_claimed, released, expired, or invalidated.' }, with_land_order: withLandOrderSchema }),
  search: objectSchema({ ...filterSchemas, query: bodySchema, with_matches: { const: true, description: 'Also return where each issue matched, with a short excerpt.' } }, ['query']),
  comment: objectSchema({ id: idSchema, body: bodySchema, ...voiceSchemas }, ['id', 'body']),
  comment_edit: objectSchema({ id: idSchema, comment_id: { type: 'string', format: 'uuid', description: 'The comment ID that show returns.' }, body: bodySchema,
    expected: { ...versionSchema, description: 'The comment version that show returned.' } }, ['id', 'comment_id', 'body', 'expected']),
  update: objectSchema({ id: idSchema, changes: { type: 'array', minItems: 1, maxItems: 7, items: {
    oneOf: fields.map((field) => objectSchema({ field: { const: field }, value: fieldRegistry[field].schema, expected: versionSchema }, ['field', 'value', 'expected']))
  } }, force: { const: true }, reason: reasonSchema, resources_reason: resourcesReasonSchema, claim_proof: claimProofSchema }, ['id', 'changes']),
  close: objectSchema({ id: idSchema, expected: versionSchema, force: { const: true }, reason: reasonSchema, resources_reason: resourcesReasonSchema, claim_proof: claimProofSchema }, ['id', 'expected']),
  reopen: objectSchema({ id: idSchema, expected: versionSchema, claim_proof: claimProofSchema }, ['id', 'expected']),
  actor: objectSchema({}),
};

function parseChange(value: unknown, index: number): Change {
  const at = `changes[${index}]`;
  if (value === null || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return expectedType(at, 'object');
  const input = value as Record<string, unknown>;
  requireFields(input, ['field', 'value', 'expected'], ['field', 'value', 'expected'], at);
  const field = enumeration(input.field, 'field', fields);
  const expected = integer(input.expected, 'expected', 1, Number.MAX_SAFE_INTEGER);
  switch (field) {
    case 'tool': return { field, expected, value: fieldRegistry.tool.parse(input.value) };
    case 'project': return { field, expected, value: fieldRegistry.project.parse(input.value) };
    case 'body': return { field, expected, value: fieldRegistry.body.parse(input.value) };
    case 'status': return { field, expected, value: fieldRegistry.status.parse(input.value) };
    case 'type': return { field, expected, value: fieldRegistry.type.parse(input.value) };
    case 'priority': return { field, expected, value: fieldRegistry.priority.parse(input.value) };
    case 'labels': return { field, expected, value: fieldRegistry.labels.parse(input.value) };
    default: { const unreachable: never = field; return unreachable; }
  }
}
function parseFilters(input: Record<string, unknown>): Filters {
  return {
    ...(input.tool === undefined ? {} : { tool: name(input.tool, 'tool') }),
    ...(input.project === undefined ? {} : { project: name(input.project, 'project') }),
    ...(input.status === undefined ? {} : { status: enumeration(input.status, 'status', statuses) }),
    ...(input.type === undefined ? {} : { type: enumeration(input.type, 'type', issueTypes) }),
    ...(input.priority === undefined ? {} : { priority: integer(input.priority, 'priority', 0, 4) }),
    ...(input.label === undefined ? {} : { label: name(input.label, 'label') }),
    ...(input.after === undefined ? {} : { after: id(input.after, 'after') }),
    limit: input.limit === undefined ? 50 : integer(input.limit, 'limit', 1, 100),
  };
}
function parseOverride(input: Record<string, unknown>): StatusOverride {
  const resources = input.resources_reason === undefined ? {} : { resources_reason: text(input.resources_reason, 'resources_reason') };
  if (input.force === undefined && input.reason === undefined) return resources;
  if (input.force === undefined) return invalid('reason is accepted only with force: true');
  if (input.force !== true || input.reason === undefined) return invalid('force requires true and a nonempty reason');
  return { force: true, reason: text(input.reason, 'reason'), ...resources };
}
function withLandOrder(input: Record<string, unknown>): { with_land_order?: true } {
  if (input.with_land_order === undefined) return {};
  if (input.with_land_order !== true) return invalid('with_land_order must be true when present');
  return { with_land_order: true };
}
export function parseOperation(value: unknown): Operation {
  const input = object(value, 'operation');
  const op = enumeration(input.op, 'op', ['create', 'show', 'list', 'search', 'comment', 'comment_edit', 'update', 'close', 'reopen', 'actor']);
  const schema = operationSchemas[op];
  requireFields(input, ['op', ...Object.keys(schema.properties)], ['op', ...schema.required]);
  switch (op) {
    case 'actor': return { op };
    case 'show': return { op, id: id(input.id), ...withLandOrder(input) };
    case 'list': {
      if (input.claimed !== undefined && typeof input.claimed !== 'boolean') return invalid('claimed must be true or false when present');
      return { op, ...parseFilters(input), ...(input.claimed === undefined ? {} : { claimed: input.claimed }), ...withLandOrder(input) };
    }
    case 'search': {
      if (input.with_matches !== undefined && input.with_matches !== true) return invalid('with_matches must be true when present');
      return { op, ...parseFilters(input), query: text(input.query, 'query'), ...(input.with_matches === true ? { with_matches: true } : {}) };
    }
    case 'comment': return { op, id: id(input.id), body: text(input.body, 'body'),
      ...(input.handle === undefined ? {} : { handle: parseHandle(input.handle) }), ...(input.via === undefined ? {} : { via: parseVia(input.via) }),
      ...(input.reply_to === undefined ? {} : { reply_to: validated(value => parseRequestId(value, 'reply_to'), input.reply_to) }) };
    case 'comment_edit': return { op, id: id(input.id), comment_id: validated(parseRequestId, input.comment_id), body: text(input.body, 'body'),
      expected: integer(input.expected, 'expected', 1, Number.MAX_SAFE_INTEGER) };
    case 'close': return { op, id: id(input.id), expected: integer(input.expected, 'expected', 1, Number.MAX_SAFE_INTEGER), ...parseOverride(input), ...(input.claim_proof === undefined ? {} : { claim_proof: parseClaimProof(input.claim_proof, id(input.id)) }) };
    case 'reopen': return { op, id: id(input.id), expected: integer(input.expected, 'expected', 1, Number.MAX_SAFE_INTEGER), ...(input.claim_proof === undefined ? {} : { claim_proof: parseClaimProof(input.claim_proof, id(input.id)) }) };
    case 'create': {
      const parent = input.parent === undefined ? undefined : id(input.parent, 'parent');
      if (parent?.split('.').length === 8) invalid('An issue cannot have more than eight number segments');
      const prefix = validated(parsePrefix, input.prefix);
      const request_id = validated(parseRequestId, input.request_id);
      if (parent && !parent.startsWith(`${prefix}-`)) invalid('Parent and child must have the same prefix');
      return { op, prefix, request_id, ...(parent === undefined ? {} : { parent }), tool: name(input.tool, 'tool'), project: name(input.project, 'project'),
        body: text(input.body, 'body'), status: input.status === undefined ? 'open' : fieldRegistry.status.parse(input.status),
        type: input.type === undefined ? 'task' : fieldRegistry.type.parse(input.type),
        priority: input.priority === undefined ? 2 : fieldRegistry.priority.parse(input.priority),
        labels: input.labels === undefined ? [] : labels(input.labels) };
    }
    case 'update': {
      if (!Array.isArray(input.changes)) return expectedType('changes', 'array');
      if (input.changes.length === 0 || input.changes.length > 7) return invalid('changes must contain one through seven fields');
      const changes = input.changes.map((change, index) => parseChange(change, index));
      const [first, ...rest] = changes;
      if (first === undefined) return invalid('changes must not be empty');
      if (new Set(changes.map((change) => change.field)).size !== changes.length) invalid('changes must not repeat a field');
      const override = parseOverride(input);
      if (override.force && !changes.some(change => change.field === 'status' && (change.value === 'in_progress' || change.value === 'closed'))) return invalid('force applies only to start or close');
      if (override.resources_reason !== undefined && !changes.some(change => change.field === 'status' && change.value === 'closed')) return invalid('resources_reason applies only to close');
      return { op, id: id(input.id), changes: [first, ...rest], ...override, ...(input.claim_proof === undefined ? {} : { claim_proof: parseClaimProof(input.claim_proof, id(input.id)) }) };
    }
  }
}

function rowsAt(results: readonly { rows: readonly Record<string, unknown>[] }[], index: number): readonly Record<string, unknown>[] {
  const result = results[index];
  if (!result) throw new PolylinedbError('storage_error', 'Database omitted a statement result', 503);
  return result.rows;
}
function notFound(issueId: string): never {
  throw new PolylinedbError('not_found', 'Issue was not found', 404, { id: issueId });
}
const observation = (issueId: string): SqlStatement => ({ sql: `SELECT issues.*,
  ${activeBlockerExists('issues.id')} AS has_active_blockers,
  EXISTS(SELECT 1 FROM issues AS child WHERE child.parent_id = issues.id) AS has_children,
  ${liveResourceExists('issues.id')} AS has_live_resources
  FROM issues WHERE id = ?`, params: [issueId] });
// An epic answers only for its own entries; a child keeps its own close guard.
const liveResourceExists = (issue: string) => `EXISTS(SELECT 1 FROM issue_resources WHERE issue_resources.issue_id = ${issue} AND issue_resources.verified_deleted_at IS NULL)`;
const liveResourceNames = (issueId: string): SqlStatement => ({ sql: `SELECT kind, name, (SELECT COUNT(*) FROM issue_resources WHERE issue_id = ? AND verified_deleted_at IS NULL) AS total
  FROM issue_resources WHERE issue_id = ? AND verified_deleted_at IS NULL ORDER BY seq LIMIT ${shownLiveResources}`, params: [issueId, issueId] });

// SET reads the row before the write, so status still holds the previous status and a closed issue keeps its first closure.
function closureAssignments(next: Status | undefined, at: string, by: string): { assignments: string[]; params: string[] } {
  if (next === undefined) return { assignments: [], params: [] };
  if (next !== 'closed') return { assignments: ['closed_at = NULL', 'closed_by = NULL'], params: [] };
  return { assignments: ["closed_at = CASE WHEN status = 'closed' THEN closed_at ELSE ? END", "closed_by = CASE WHEN status = 'closed' THEN closed_by ELSE ? END"], params: [at, by] };
}

async function update(db: SqlExecutor, issueId: string, changes: readonly Change[], caller: Actor, override: StatusOverride = {}, proof?: ClaimProof): Promise<OperationResult> {
  const actor = caller.id;
  const assignments: string[] = [];
  const gate = agentHoldsClaim(issueId, caller);
  const conditions = ['id = ?', gate.sql];
  const params: (string | number | null)[] = [];
  const guards: (string | number | null)[] = [issueId, ...gate.params];
  const statusChange = changes.find((change): change is Extract<Change, { field: 'status' }> => change.field === 'status');
  const typeChange = changes.find((change): change is Extract<Change, { field: 'type' }> => change.field === 'type');
  const ownership = issueClaimGuard(issueId, proof, { status: statusChange?.value ?? null, type: typeChange?.value ?? null }, actor);
  conditions.push(ownership.sql); guards.push(...ownership.params);
  const guardedStatus = statusChange?.value === 'in_progress' || statusChange?.value === 'closed';
  if (guardedStatus && !override.force) conditions.push(`NOT ${activeBlockerExists('issues.id')}`);
  const closing = statusChange?.value === 'closed';
  if (closing && override.resources_reason === undefined) conditions.push(`NOT ${liveResourceExists('issues.id')}`);
  for (const change of changes) {
    assignments.push(`${fieldRegistry[change.field].column} = ?`, `${change.field}_v = ${change.field}_v + 1`);
    params.push(change.field === 'labels' ? JSON.stringify(change.value) : change.value);
    conditions.push(`${change.field}_v = ?`, `${change.field}_v < 9007199254740991`);
    guards.push(change.expected);
    if (change.field === 'type' && change.value !== 'epic') conditions.push('NOT EXISTS(SELECT 1 FROM issues AS child WHERE child.parent_id = issues.id)');
  }
  const now = new Date().toISOString();
  const closure = closureAssignments(statusChange?.value, now, actor);
  assignments.push('updated_by = ?', 'updated_at = ?', ...closure.assignments);
  params.push(actor, now, ...closure.params, ...guards);
  // Each reason comment lands only when the update changed the row; the earlier comment insert also leaves changes() at 1.
  const reasons = [override.force ? override.reason : undefined, override.resources_reason].filter((reason): reason is string => reason !== undefined);
  const result = await recordingChanges(db, actor).batch([{ sql: `UPDATE issues SET ${assignments.join(', ')} WHERE ${conditions.join(' AND ')} RETURNING *`, params },
    ...reasons.map(reason => ({ sql: 'INSERT INTO comments(id,issue_id,body,created_at,created_by) SELECT ?,?,?,?,? WHERE changes() = 1', params: [crypto.randomUUID(), issueId, reason, new Date().toISOString(), actor] })),
    observation(issueId), heldClaimObservation(issueId), ...(closing ? [liveResourceNames(issueId)] : [])]);
  const changed = rowsAt(result, 0)[0];
  if (changed) return { issue: issueRow(changed) };
  const observed = rowsAt(result, 1 + reasons.length)[0];
  if (!observed) return notFound(issueId);
  const issue = issueRow(observed);
  const ownershipRow = rowsAt(result, 2 + reasons.length)[0];
  if (!ownershipRow || typeof ownershipRow.store_incarnation !== 'string' || typeof ownershipRow.observed_at !== 'number') throw new PolylinedbError('storage_error', 'Database omitted the claim observation', 503);
  rejectAgentWrite(caller, 'issue_write', issueId, issue.labels, ownershipRow);
  const decision = decideIssueUpdate({ id: issueId, status: issue.status, type: issue.type, versions: issue.versions, has_active_blockers: observed.has_active_blockers === 1, has_children: observed.has_children === 1, has_live_resources: observed.has_live_resources === 1,
    claim: ownershipRow.generation === null ? null : claimRow(ownershipRow), store_incarnation: ownershipRow.store_incarnation },
    { changes, force: override.force === true, resources_acknowledged: override.resources_reason !== undefined, ...(proof === undefined ? {} : { claim_proof: proof }) }, actor, ownershipRow.observed_at);
  if (decision.accepted) throw new PolylinedbError('storage_error', 'The database rejected an update without a matching condition', 503);
  const rejection = decision.rejection;
  switch (rejection.code) {
    case 'conflict': throw new PolylinedbError('conflict', 'Read the current issue before deciding on a new update', 409,
      { issue, fields: rejection.fields.map(conflict => ({ ...conflict, current: issue[conflict.field] })) });
    case 'claim_required': {
      if (proof === undefined) throw new PolylinedbError('claim_required', 'A current ownership proof is required for this update', 409, { issue });
      const lease = ownershipRow.generation === null ? null : claimRow(ownershipRow);
      const state = claimState(lease, ownershipRow.store_incarnation, ownershipRow.observed_at);
      const claim = lease === null ? { state } : { state, generation: lease.generation, expires_at: lease.expires_at };
      throw new PolylinedbError('claim_required', 'A current ownership proof is required for this update', 409, { issue, claim });
    }
    case 'dependency_blocked': throw new PolylinedbError('dependency_blocked', 'The issue has active prerequisites', 409, { issue });
    case 'resources_remaining': {
      // No details: released clients decode an error code they do not know only when it carries none.
      const live = rowsAt(result, 3 + reasons.length);
      const names = live.map(row => `${String(row.kind)}:${String(row.name)}`);
      throw new PolylinedbError('resources_remaining', `The issue still has external resources that are not verified deleted: ${liveResourceSummary(names, Number(live[0]?.total ?? names.length))}. Mark each one verified_deleted with resource_update, or close with resources_reason.`, 409);
    }
    case 'version_exhausted': throw new PolylinedbError('version_exhausted', 'The field version cannot increase', 409, { field: rejection.field, issue });
    case 'epic_has_children': throw new PolylinedbError('epic_has_children', 'An epic with children must remain an epic', 409, { issue });
    default: { const unreachable: never = rejection; return unreachable; }
  }
}

// One guarded UPDATE decides the edit, so two writers that read the same version cannot both succeed. The issue keeps its updated_at and field versions.
async function editComment(db: SqlExecutor, operation: Extract<Operation, { op: 'comment_edit' }>, caller: Actor): Promise<OperationResult> {
  const actor = caller.id;
  const gate = agentHoldsClaim(operation.id, caller);
  const result = await recordingChanges(db, actor).batch([
    { sql: `UPDATE comments SET body = ?, version = version + 1, updated_at = ?, updated_by = ?
      WHERE id = ? AND issue_id = ? AND created_by = ? AND version = ? AND version < 9007199254740991 AND ${gate.sql} RETURNING *`,
    params: [operation.body, new Date().toISOString(), actor, operation.comment_id, operation.id, actor, operation.expected, ...gate.params] },
    { sql: 'SELECT labels_json FROM issues WHERE id = ?', params: [operation.id] },
    { sql: 'SELECT * FROM comments WHERE id = ? AND issue_id = ?', params: [operation.comment_id, operation.id] },
    ...(caller.kind === 'agent' ? [heldClaimObservation(operation.id)] : [])]);
  const row = rowsAt(result, 0)[0];
  if (row) return { comment: storedCommentRow(row) };
  const issue = rowsAt(result, 1)[0];
  if (!issue) return notFound(operation.id);
  const stored = rowsAt(result, 2)[0];
  const comment = stored === undefined ? null : storedCommentRow(stored);
  const decision = decideCommentEdit(comment, { actor, expected: operation.expected });
  const named = { id: operation.id, comment_id: operation.comment_id };
  if (!decision.accepted && decision.code === 'comment_not_found') throw new PolylinedbError('comment_not_found', 'Comment was not found on this issue', 404, named);
  if (!decision.accepted && decision.code === 'comment_author_required') throw new PolylinedbError('comment_author_required', 'Only the author of a comment can edit it', 403, named);
  if (typeof issue.labels_json !== 'string') throw new PolylinedbError('invalid_store', 'Stored issue is invalid: labels_json is not text', 500);
  rejectAgentWrite(caller, 'issue_write', operation.id, labels(JSON.parse(issue.labels_json)), caller.kind === 'agent' ? rowsAt(result, 3)[0] : undefined);
  if (decision.accepted || comment === null) throw new PolylinedbError('storage_error', 'The database rejected a comment edit without a matching condition', 503);
  if (decision.code === 'comment_conflict') throw new PolylinedbError('comment_conflict', 'Comment changed; read it again before editing', 409, { comment, expected: operation.expected });
  throw new PolylinedbError('comment_version_exhausted', 'Comment version reached its limit', 409, { comment });
}

// The guard keeps a reply on the issue of its target in the same INSERT, so the reply trigger only backs up writes that skip operations.
// A refusal names a missing issue first, then a missing reply target, then the agent claim gate, as decideReply orders them.
async function writeComment(db: SqlExecutor, operation: Extract<Operation, { op: 'comment' }>, caller: Actor): Promise<OperationResult> {
  const actor = caller.id;
  const gate = agentHoldsClaim(operation.id, caller);
  const replyTo = operation.reply_to ?? null;
  const observe = caller.kind === 'agent' || replyTo !== null;
  const result = await recordingChanges(db, actor).batch([{ sql: `INSERT INTO comments(id, issue_id, body, created_at, created_by, handle, via, reply_to)
    SELECT ?, id, ?, ?, ?, ?, ?, ? FROM issues WHERE id = ? AND ${gate.sql}
    AND (? IS NULL OR EXISTS(SELECT 1 FROM comments AS target WHERE target.id = ? AND target.issue_id = issues.id)) RETURNING *`,
  params: [crypto.randomUUID(), operation.body, new Date().toISOString(), actor, operation.handle ?? null, operation.via ?? null, replyTo,
    operation.id, ...gate.params, replyTo, replyTo] },
  ...(observe ? [observation(operation.id), { sql: 'SELECT 1 AS found FROM comments WHERE id = ? AND issue_id = ?', params: [replyTo, operation.id] }] : []),
  ...(caller.kind === 'agent' ? [heldClaimObservation(operation.id)] : [])]);
  const row = rowsAt(result, 0)[0];
  if (row) return { comment: storedCommentRow(row) };
  const observed = observe ? rowsAt(result, 1)[0] : undefined;
  const reply = decideReply({ issue: observed !== undefined, replyTarget: replyTo === null ? null : rowsAt(result, 2).length > 0 });
  if (!reply.accepted && reply.code === 'not_found') return notFound(operation.id);
  if (!reply.accepted) throw new PolylinedbError('reply_target_not_found', 'The reply target is not a comment on this issue', 404, { id: operation.id, reply_to: replyTo });
  if (observed) rejectAgentWrite(caller, 'issue_write', operation.id, issueRow(observed).labels, rowsAt(result, 3)[0]);
  throw new PolylinedbError('storage_error', 'The database rejected a comment without a matching condition', 503);
}

export async function executeOperation(db: SqlExecutor, operation: Operation, by: string | Actor): Promise<OperationResult> {
  const caller = asActor(by);
  const actor = caller.id;
  if (operation.op === 'actor') return { actor: name(actor, 'actor') };
  if (!['show', 'list', 'search'].includes(operation.op)) name(actor, 'actor');
  switch (operation.op) {
    case 'create': {
      if (startedWorkNeedsClaim(operation.status, operation.type)) invalid('A new issue cannot start in_progress unless it is an epic. Create it open, acquire a claim, then set in_progress with the claim proof');
      const scope = operation.parent ?? operation.prefix;
      const base = operation.parent ? `${operation.parent}.` : `${operation.prefix}-`;
      const sortBase = operation.parent ? `${issueSortKey(operation.parent)}.` : `${operation.prefix}-`;
      const payload = JSON.stringify(parseOperation(operation));
      const now = new Date().toISOString();
      const eligible = `NOT EXISTS(SELECT 1 FROM requests WHERE request_id = ?)${operation.parent ? " AND EXISTS(SELECT 1 FROM issues WHERE id = ? AND type = 'epic')" : ''}`;
      const gate = operation.parent ? [operation.request_id, operation.parent] : [operation.request_id];
      const closure = operation.status === 'closed' ? { columns: ', closed_at, closed_by', values: ', ?, ?', params: [now, actor] } : { columns: '', values: '', params: [] };
      const result = await recordingChanges(db, actor).batch([
        { sql: `INSERT INTO counters(scope, last_number) SELECT ?, 1 WHERE ${eligible}
          ON CONFLICT(scope) DO UPDATE SET last_number = last_number + 1`, params: [scope, ...gate] },
        { sql: `INSERT INTO issues(id, parent_id, sort_key, tool, project, body, status, type, priority, labels_json, created_at, created_by, updated_at, updated_by${closure.columns})
          SELECT ? || last_number, ?, ? || printf('%016d', last_number), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${closure.values}
          FROM counters WHERE scope = ? AND ${eligible}`,
          params: [base, operation.parent ?? null, sortBase, operation.tool, operation.project, operation.body, operation.status, operation.type, operation.priority, JSON.stringify(operation.labels), now, actor, now, actor, ...closure.params, scope, ...gate] },
        { sql: `INSERT INTO requests(request_id, actor, payload, issue_id)
          SELECT ?, ?, ?, ? || last_number FROM counters WHERE scope = ? AND ${eligible}`,
          params: [operation.request_id, actor, payload, base, scope, ...gate] },
        { sql: 'SELECT * FROM requests WHERE request_id = ?', params: [operation.request_id] },
        { sql: 'SELECT issues.* FROM issues JOIN requests ON requests.issue_id = issues.id WHERE requests.request_id = ?', params: [operation.request_id] },
        ...(operation.parent ? [observation(operation.parent)] : []),
      ]).catch((error: unknown) => {
        if (error instanceof Error && error.message.includes('counter_not_exhausted')) throw new PolylinedbError('counter_exhausted', 'The issue counter has reached its limit', 409);
        throw error;
      });
      const request = rowsAt(result, 3)[0];
      if (request && decideReplay(request, actor, payload) === 'request_conflict') throw new PolylinedbError('request_conflict', 'The request ID belongs to a different actor or payload', 409);
      const row = rowsAt(result, 4)[0];
      if (row) return { issue: issueRow(row) };
      if (operation.parent !== undefined) {
        const parentRow = rowsAt(result, 5)[0];
        const creation = decideCreation(operation.parent, parentRow ? { type: issueRow(parentRow).type } : null);
        if (!creation.accepted && creation.reason === 'parent_not_found') return notFound(operation.parent);
        if (!creation.accepted) throw new PolylinedbError('invalid_input', 'The parent must be an epic', 400);
      }
      throw new PolylinedbError('storage_error', 'The database rejected a creation without a matching condition', 503);
    }
    case 'show': {
      const rows = await db.reads.all(issueQueries.show, { id: operation.id });
      const [row] = rows;
      if (!row) return notFound(operation.id);
      return { issue: issueRow(row), comments: rows.filter(row => row.comment_id !== null).map(row => shownCommentRow({
        id: row.comment_id, issue_id: row.id, body: row.comment_body,
        created_at: row.comment_created_at, created_by: row.comment_created_by,
        version: row.comment_version, updated_at: row.comment_updated_at, updated_by: row.comment_updated_by,
        handle: row.comment_handle, via: row.comment_via, reply_to: row.comment_reply_to,
        stars: row.comment_stars, starrers: starrerNames(row.comment_starrers_json),
      })), claim: await inspectClaim(db, operation.id) };
    }
    case 'comment_edit': return editComment(db, operation, caller);
    case 'comment': return writeComment(db, operation, caller);
    case 'close': return update(db, operation.id, [{ field: 'status', value: 'closed', expected: operation.expected }], caller, operation, operation.claim_proof);
    case 'reopen': return update(db, operation.id, [{ field: 'status', value: 'open', expected: operation.expected }], caller, {}, operation.claim_proof);
    case 'update': return update(db, operation.id, operation.changes, caller, operation, operation.claim_proof);
    case 'list': case 'search': {
      const query = operation.tool === undefined ? issueQueries.list
        : operation.project === undefined ? issueQueries.listByTool
        : operation.status === undefined ? issueQueries.listByScope
        : issueQueries.listByStatus;
      const rows = await db.reads.all(query, {
        tool: operation.tool ?? null, project: operation.project ?? null,
        status: operation.status ?? null, type: operation.type ?? null,
        priority: operation.priority ?? null, label: operation.label ?? null,
        after: operation.after === undefined ? '' : issueSortKey(operation.after),
        query: operation.op === 'search' ? operation.query : null, limit: operation.limit + 1,
        claimed: operation.op === 'list' && operation.claimed !== undefined ? Number(operation.claimed) : null,
      });
      const all = rows.map(issueRow);
      const issues = all.slice(0, operation.limit);
      const next_cursor = all.length > operation.limit ? issues[issues.length - 1]?.id ?? null : null;
      if (operation.op === 'search' && operation.with_matches) return { issues, next_cursor, matches: await searchMatches(db, issues, operation.query) };
      return { issues, next_cursor };
    }
    default: { const unreachable: never = operation; return unreachable; }
  }
}

// A recorded closure sorts by closed_at. A null closure, from a close before schema 8, sorts after those by updated_at. Comments never touch updated_at.
export async function recentlyClosedIssues(db: SqlExecutor, limit: number): Promise<Issue[]> {
  return (await db.reads.all(issueQueries.recentlyClosed, { limit })).map(issueRow);
}

export async function projectClosedIssues(db: SqlExecutor, tool: string, project: string, limit: number): Promise<Issue[]> {
  return (await db.reads.all(issueQueries.projectClosed, { tool, project, limit })).map(issueRow);
}

export async function recentUpdates(db: SqlExecutor, limit: number): Promise<Issue[]> {
  return (await db.reads.all(issueQueries.recentUpdates, { limit })).map(issueRow);
}

export type IssueLink = { id: string; body: string; status: Status };

function issueLink(row: { id: unknown; body: unknown; status: unknown }): IssueLink {
  try {
    return { id: id(row.id), body: text(row.body, 'body'), status: enumeration(row.status, 'status', statuses) };
  } catch (error) {
    throw new PolylinedbError('invalid_store', `Stored issue link is invalid: ${error instanceof Error ? error.message : 'invalid row'}`, 500);
  }
}

export async function issueParent(db: SqlExecutor, issueId: string): Promise<IssueLink | null> {
  const row = (await db.reads.all(issueQueries.issueParent, { id: issueId }))[0];
  return row === undefined ? null : issueLink(row);
}

export async function issueChildren(db: SqlExecutor, issueId: string, limit: number): Promise<IssueLink[]> {
  return (await db.reads.all(issueQueries.issueChildren, { id: issueId, limit })).map(issueLink);
}

export async function issueDispatchScope(db: SqlExecutor, issueId: string): Promise<{ tool: string; project: string } | null> {
  const row = (await db.reads.all(issueQueries.issueDispatchScope, { id: issueId }))[0];
  if (row === undefined) return null;
  if (typeof row.tool !== 'string' || row.tool.length === 0 || typeof row.project !== 'string' || row.project.length === 0) {
    throw new PolylinedbError('invalid_store', 'Stored issue scope is invalid', 500);
  }
  return { tool: row.tool, project: row.project };
}

/** `blockerIds` are the active blockers in issue order; `dependencyRevision` is the revision dependency_add and dependency_remove expect. */
export type BlockedIssue = { issue: Issue; openBlockers: number; blockerIds: string[]; dependencyRevision: number };
/** `total` counts every blocked issue, including those past the limit. */
export async function blockedIssues(db: SqlExecutor, limit: number): Promise<{ rows: BlockedIssue[]; total: number }> {
  const rows = await db.reads.all(issueQueries.blockedIssues, { limit });
  return { total: rows[0] === undefined ? 0 : storedCount(rows[0].total), rows: rows.map(row => {
    const ids: unknown = typeof row.blocker_ids === 'string' ? JSON.parse(row.blocker_ids) : row.blocker_ids;
    if (!Array.isArray(ids)) throw new PolylinedbError('invalid_store', 'Stored blocker list is invalid', 500);
    return { issue: issueRow(row), openBlockers: storedCount(row.open_blockers), blockerIds: ids.map(value => id(value)),
      dependencyRevision: integer(row.dependency_revision, 'dependency_revision', 1, Number.MAX_SAFE_INTEGER) };
  }) };
}

/** In-progress issues other than epics with no active claim. Expired claims come first, then the least recently updated. */
export type StartedIssue = { issue: Issue; claim: ClaimDisplay };
export async function startedWithoutClaim(db: SqlExecutor, limit: number): Promise<{ rows: StartedIssue[]; total: number; expired: number }> {
  const rows = await db.reads.all(issueQueries.startedWithoutClaim, { limit });
  const head = rows[0];
  return {
    total: head === undefined ? 0 : storedCount(head.total),
    expired: head === undefined ? 0 : storedCount(head.expired_total),
    rows: rows.map(row => ({ issue: issueRow(row), claim: displayedClaim(row) })),
  };
}

function displayedClaim(row: Record<string, unknown>): ClaimDisplay {
  if (row.claim_generation === null) return { state: 'never_claimed' };
  const lease = claimRow({ issue_id: row.id, incarnation: row.claim_incarnation, actor: row.claim_actor, session_id: row.claim_session_id,
    agent_label: row.claim_agent_label, generation: row.claim_generation, revision: row.claim_revision, acquired_at: row.claim_acquired_at,
    changed_at: row.claim_changed_at, expires_at: row.claim_expires_at, released_at: row.claim_released_at });
  const state = claimState(lease, parseIncarnation(row.store_incarnation), clock(row.observed_at as number | null));
  if (state === 'never_claimed') return { state };
  return { state, actor: lease.actor, agentLabel: lease.agent_label, expiresAt: lease.expires_at, releasedAt: lease.released_at };
}

/** `lastNote` is the holder's newest comment since the lease began, when one exists. */
export type ActiveClaimIssue = { issue: Issue; actor: string; agentLabel: string | null; acquiredAt: number; expiresAt: number;
  lastNote: { body: string; at: string } | null };
export async function activeClaimIssues(db: SqlExecutor, limit: number): Promise<ActiveClaimIssue[]> {
  const rows = await db.reads.all(issueQueries.activeClaims, { limit });
  return rows.flatMap(row => {
    const issue = issueRow(row);
    if (row.claim_generation === null) return [];
    const lease = claimRow({ issue_id: issue.id, incarnation: row.claim_incarnation, actor: row.claim_actor, session_id: row.claim_session_id,
      agent_label: row.claim_agent_label, generation: row.claim_generation, revision: row.claim_revision, acquired_at: row.claim_acquired_at,
      changed_at: row.claim_changed_at, expires_at: row.claim_expires_at, released_at: row.claim_released_at });
    const state = claimState(lease, parseIncarnation(row.store_incarnation), clock(row.observed_at));
    if (state !== 'active') return [];
    const lastNote = typeof row.note_body === 'string' && typeof row.note_created_at === 'string' ? { body: row.note_body, at: row.note_created_at } : null;
    return [{ issue, actor: lease.actor, agentLabel: lease.agent_label, acquiredAt: lease.acquired_at, expiresAt: lease.expires_at, lastNote }];
  });
}

export type ProjectSummary = {
  tool: string;
  project: string;
  lastUpdatedAt: string;
  counts: { open: number; in_progress: number; deferred: number; closed: number };
};

function storedCount(value: number | null): number {
  if (value === null || !Number.isSafeInteger(value) || value < 0) throw new PolylinedbError('invalid_store', 'Stored project count is invalid', 500);
  return value;
}

export async function projectSummaries(db: SqlExecutor, limit: number): Promise<ProjectSummary[]> {
  return (await db.reads.all(issueQueries.projectSummaries, { limit })).map(row => {
    try {
      return { tool: name(row.tool, 'tool'), project: name(row.project, 'project'), lastUpdatedAt: text(row.last_updated_at, 'last_updated_at'), counts: {
        open: storedCount(row.open_count), in_progress: storedCount(row.in_progress_count),
        deferred: storedCount(row.deferred_count), closed: storedCount(row.closed_count),
      } };
    } catch (error) {
      if (error instanceof PolylinedbError && error.status === 500) throw error;
      throw new PolylinedbError('invalid_store', `Stored project is invalid: ${error instanceof Error ? error.message : 'invalid row'}`, 500);
    }
  });
}

export type ProjectIssue = { issue: Issue; openBlockers: number; claim: ClaimDisplay };

function clock(value: number | null): number {
  if (value === null || !Number.isSafeInteger(value) || value < 0) throw new PolylinedbError('invalid_store', 'Stored claim clock is invalid', 500);
  return value;
}

export async function projectIssues(db: SqlExecutor, tool: string, project: string, limit: number, status: Status | null = null, label: string | null = null): Promise<ProjectIssue[]> {
  return (await db.reads.all(issueQueries.projectIssues, { tool, project, limit, status, label, closed: status === 'closed' ? 1 : 0 })).map(row => {
    const issue = issueRow(row);
    const openBlockers = storedCount(row.open_blockers);
    if (row.claim_generation === null) return { issue, openBlockers, claim: { state: 'never_claimed' } };
    const lease = claimRow({ issue_id: issue.id, incarnation: row.claim_incarnation, actor: row.claim_actor, session_id: row.claim_session_id,
      agent_label: row.claim_agent_label, generation: row.claim_generation, revision: row.claim_revision, acquired_at: row.claim_acquired_at,
      changed_at: row.claim_changed_at, expires_at: row.claim_expires_at, released_at: row.claim_released_at });
    const state = claimState(lease, parseIncarnation(row.store_incarnation), clock(row.observed_at));
    if (state === 'never_claimed') return { issue, openBlockers, claim: { state } };
    return { issue, openBlockers, claim: { state, actor: lease.actor, agentLabel: lease.agent_label, expiresAt: lease.expires_at, releasedAt: lease.released_at } };
  });
}

// The excerpt bound counts UTF-8 bytes, including the ellipses; the SQL window counts code points, and each code point costs at least one byte.
const excerptBytes = 160;
const ellipsis = '…';
type MatchWindow = { before: string; match: string; after: string; more_before: boolean; more_after: boolean };
const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;
function fit(points: readonly string[], budget: number): string[] {
  const kept: string[] = [];
  for (const point of points) {
    budget -= utf8Bytes(point);
    if (budget < 0) break;
    kept.push(point);
  }
  return kept;
}
function excerpt(window: MatchWindow): string {
  const visible = (part: string) => Array.from(part.replace(/\p{Cc}/gu, ' '));
  const before = visible(window.before).reverse(); const match = visible(window.match); const after = visible(window.after);
  const room = excerptBytes - 2 * utf8Bytes(ellipsis);
  const shown = fit(match, room);
  const lead = (kept: number) => kept < before.length || window.more_before ? ellipsis : '';
  if (shown.length < match.length) return lead(0) + shown.join('') + ellipsis;
  const left = room - utf8Bytes(shown.join(''));
  const tail = fit(after, left - Math.min(utf8Bytes(before.join('')), Math.floor(left / 2)));
  const head = fit(before, left - utf8Bytes(tail.join('')));
  return lead(head.length) + head.reverse().join('') + shown.join('') + tail.join('')
    + (tail.length < after.length || window.more_after ? ellipsis : '');
}
async function searchMatches(db: SqlExecutor, issues: readonly Issue[], query: string): Promise<SearchMatch[]> {
  const comments = await db.reads.all(issueQueries.commentMatches, { query, context: excerptBytes, ids: issues.map(issue => issue.id) });
  return issues.flatMap((issue): SearchMatch[] => {
    const at = issue.body.indexOf(query);
    const body: SearchMatch[] = at < 0 ? [] : [{ issue_id: issue.id, location: 'body', excerpt: excerpt({
      before: issue.body.slice(0, at), match: query, after: issue.body.slice(at + query.length), more_before: false, more_after: false }) }];
    return [...body, ...comments.filter(row => row.issue_id === issue.id).map((row): SearchMatch => ({
      issue_id: issue.id, location: 'comment', comment_id: validated(parseRequestId, row.id),
      excerpt: excerpt({ before: row.before ?? '', match: query, after: row.after ?? '', more_before: row.more_before === 1, more_after: row.more_after === 1 }) }))];
  });
}
