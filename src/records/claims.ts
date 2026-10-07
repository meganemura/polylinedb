// Owns lease commands, inspection, and immutable replay; issue fields and transports retain their own contracts.
import { PolylinedbError } from './errors.ts';
import { parseIssueId, parseRequestId, issueSortKey } from './issue-id.ts';
import { issueQueries } from './issue-queries.ts';
import { claimMutationStatements } from './claims-sql.ts';
import type { ClaimMutation, ClaimProof } from './claims-sql.ts';
import type { SqlExecutor, SqlStatement } from './issues.ts';
import { claimState, decideClaimMutation, decideReplay } from '../transition/index.ts';
import type { ClaimState } from '../transition/index.ts';

export type Claim = ClaimProof & { actor: string; agent_label: string | null; revision: number; acquired_at: number; changed_at: number; expires_at: number; released_at: number | null };
export type ClaimReceipt = Omit<Claim, 'released_at'> & ({ outcome: 'released'; released_at: number } | { outcome: 'acquired' | 'renewed'; released_at: null });
export type ClaimRequest = ClaimReceipt & { request_id: string; payload: string; created_at: number };
export type { ClaimState };
export type ClaimInspection = { issue_id: string; store_incarnation: string; observed_at: number; state: ClaimState; lease: Claim | null };
export type ClaimOperation = ClaimMutation | { op: 'claim_show'; issue_id: string }
  | { op: 'claim_list'; tool?: string; project?: string; after?: string; limit: number };
export type ClaimResult = { claim: ClaimInspection } | { claim_receipt: ClaimReceipt } | { claims: ClaimInspection[]; next_cursor: string | null };
const idSchema = { type: 'string', pattern: String.raw`^[a-z][a-z0-9]{0,15}-[1-9][0-9]*(\.[1-9][0-9]*){0,7}$` };
const uuidSchema = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const incarnationSchema = { type: 'string', pattern: '^[a-f0-9]{32}$' };
const counterSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const ttlSchema = { type: 'integer', minimum: 30, maximum: 3600, default: 300 };
const objectSchema = (properties: Record<string, unknown>, required: readonly string[]) => ({ type: 'object', additionalProperties: false, properties, required });
export const claimProofSchema = objectSchema({ issue_id: idSchema, incarnation: incarnationSchema, session_id: uuidSchema, generation: counterSchema }, ['issue_id', 'incarnation', 'session_id', 'generation']);
const mutationProperties = { claim_proof: claimProofSchema, expected_revision: counterSchema, request_id: uuidSchema };
export const claimSchemas = {
  claim_show: objectSchema({ issue_id: idSchema }, ['issue_id']),
  claim_list: objectSchema({ tool: { type: 'string', minLength: 1, maxLength: 256 }, project: { type: 'string', minLength: 1, maxLength: 256 }, after: idSchema, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }, []),
  claim_acquire: objectSchema({ issue_id: idSchema, incarnation: incarnationSchema, session_id: uuidSchema, request_id: uuidSchema, ttl: ttlSchema, agent_label: { type: ['string', 'null'], minLength: 1, maxLength: 64, description: 'Caller metadata, at most 64 UTF-8 bytes. Omitted labels become null.' } }, ['issue_id', 'incarnation', 'session_id', 'request_id']),
  claim_renew: objectSchema({ ...mutationProperties, ttl: ttlSchema }, ['claim_proof', 'expected_revision', 'request_id']),
  claim_release: objectSchema(mutationProperties, ['claim_proof', 'expected_revision', 'request_id']),
};
const invalid = (message: string): never => { throw new PolylinedbError('invalid_input', message); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return invalid('Claim input must be a plain object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`Unknown field: ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`Missing field: ${key}`);
}
function identifier(parser: (value: unknown) => string, value: unknown): string {
  try { return parser(value); } catch (error) { return invalid(error instanceof Error ? error.message : 'Invalid identifier'); }
}
export function parseIncarnation(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) return invalid('incarnation must contain 32 lowercase hexadecimal digits');
  return value;
}
function integer(value: unknown, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid(`${name} must be an integer from ${minimum} through ${maximum}`);
  return value;
}
function name(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== 'string' || !value.trim() || /\p{Cc}/u.test(value) || new TextEncoder().encode(value).length > maximum) return invalid(`Invalid ${label}`);
  return value;
}
export function parseClaimProof(value: unknown, target?: string): ClaimProof {
  const input = object(value);
  keys(input, claimProofSchema.required, claimProofSchema.required);
  const issue_id = identifier(parseIssueId, input.issue_id);
  if (target !== undefined && issue_id !== target) return invalid('claim_proof must target the requested issue');
  return { issue_id, incarnation: parseIncarnation(input.incarnation), session_id: identifier(parseRequestId, input.session_id), generation: integer(input.generation, 'generation', 1) };
}
export function parseClaimOperation(value: unknown): ClaimOperation {
  const input = object(value);
  const op = input.op;
  if (op !== 'claim_show' && op !== 'claim_list' && op !== 'claim_acquire' && op !== 'claim_renew' && op !== 'claim_release') return invalid('Unknown claim operation');
  const schema = claimSchemas[op]; keys(input, ['op', ...Object.keys(schema.properties)], ['op', ...schema.required]);
  if (op === 'claim_list') return { op, limit: input.limit === undefined ? 50 : integer(input.limit, 'limit', 1, 100), ...(input.tool === undefined ? {} : { tool: name(input.tool, 'tool') }), ...(input.project === undefined ? {} : { project: name(input.project, 'project') }), ...(input.after === undefined ? {} : { after: identifier(parseIssueId, input.after) }) };
  if (op === 'claim_show') return { op, issue_id: identifier(parseIssueId, input.issue_id) };
  const request_id = identifier(parseRequestId, input.request_id);
  if (op === 'claim_acquire') return { op, issue_id: identifier(parseIssueId, input.issue_id), incarnation: parseIncarnation(input.incarnation), session_id: identifier(parseRequestId, input.session_id), request_id, ttl: input.ttl === undefined ? 300 : integer(input.ttl, 'ttl', 30, 3600), agent_label: input.agent_label === undefined || input.agent_label === null ? null : name(input.agent_label, 'agent_label', 64) };
  const claim_proof = parseClaimProof(input.claim_proof); const expected_revision = integer(input.expected_revision, 'expected_revision', 1);
  return op === 'claim_release' ? { op, claim_proof, expected_revision, request_id } : { op, claim_proof, expected_revision, request_id, ttl: input.ttl === undefined ? 300 : integer(input.ttl, 'ttl', 30, 3600) };
}
export function claimRow(row: Record<string, unknown>): Claim {
  try {
    const acquired_at = integer(row.acquired_at, 'acquired_at', 0);
    const changed_at = integer(row.changed_at, 'changed_at', acquired_at);
    const released_at = row.released_at === null ? null : integer(row.released_at, 'released_at', 0);
    if (released_at !== null && released_at !== changed_at) return invalid('released_at must equal changed_at');
    return { ...parseClaimProof({ issue_id: row.issue_id, incarnation: row.incarnation, session_id: row.session_id, generation: row.generation }), actor: name(row.actor, 'actor'), agent_label: row.agent_label === null ? null : name(row.agent_label, 'agent_label', 64), revision: integer(row.revision, 'revision', 1), acquired_at, changed_at, expires_at: integer(row.expires_at, 'expires_at', acquired_at + 1), released_at };
  } catch (error) { throw new PolylinedbError('invalid_store', error instanceof Error ? error.message : 'Invalid stored claim', 500); }
}
export function claimRequestRow(row: Record<string, unknown>): ClaimRequest {
  const claim = claimRow(row);
  const outcome = row.outcome;
  if (outcome !== 'acquired' && outcome !== 'renewed' && outcome !== 'released') throw new PolylinedbError('invalid_store', 'Invalid claim outcome', 500);
  if ((outcome === 'released') !== (claim.released_at !== null) || row.created_at !== claim.changed_at || typeof row.payload !== 'string') throw new PolylinedbError('invalid_store', 'Invalid claim receipt', 500);
  try {
    JSON.parse(row.payload); const request = { ...claim, request_id: parseRequestId(row.request_id), payload: row.payload, created_at: claim.changed_at };
    if (outcome === 'released' && claim.released_at !== null) return { ...request, outcome, released_at: claim.released_at };
    if ((outcome === 'acquired' || outcome === 'renewed') && claim.released_at === null) return { ...request, outcome, released_at: null };
    throw new Error('Invalid released receipt');
  }
  catch { throw new PolylinedbError('invalid_store', 'Invalid claim receipt payload or ID', 500); }
}
function inspection(row: Record<string, unknown>): ClaimInspection {
  const issue_id = identifier(parseIssueId, row.issue_id);
  const store_incarnation = parseIncarnation(row.store_incarnation);
  const observed_at = integer(row.observed_at, 'observed_at', 0);
  const lease = row.generation === null ? null : claimRow(row);
  return { issue_id, store_incarnation, observed_at, state: claimState(lease, store_incarnation, observed_at), lease };
}
function duplicateReceipt(error: unknown): boolean {
  let cause = error; const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && cause instanceof Error && !seen.has(cause); depth++) {
    seen.add(cause);
    const marker = 'UNIQUE constraint failed: claim_requests.request_id';
    if (['', ': SQLITE_CONSTRAINT', ': SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)', ': SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)'].some(suffix => cause instanceof Error && (cause.message === marker + suffix || cause.message === `D1_ERROR: ${marker}${suffix}`))) return true;
    cause = cause.cause;
  }
  return false;
}
function receipt(row: Record<string, unknown>): ClaimReceipt {
  const { request_id: _, payload: __, created_at: ___, ...result } = claimRequestRow(row); return result;
}
export async function executeClaimOperation(db: SqlExecutor, operation: ClaimOperation, actor: string): Promise<ClaimResult> {
  if (operation.op === 'claim_list') {
    const all = (await db.reads.all(issueQueries.claimList, { tool: operation.tool ?? null, project: operation.project ?? null, after: operation.after === undefined ? '' : issueSortKey(operation.after), limit: operation.limit + 1 })).map(inspection);
    const claims = all.slice(0, operation.limit); return { claims, next_cursor: all.length > operation.limit ? claims.at(-1)?.issue_id ?? null : null };
  }
  if (operation.op === 'claim_show') {
    const row = (await db.reads.all(issueQueries.claimShow, { issue_id: operation.issue_id }))[0];
    if (!row) throw new PolylinedbError('not_found', 'Issue was not found', 404, { id: operation.issue_id });
    return { claim: inspection(row) };
  }
  name(actor, 'actor');
  const payload = JSON.stringify(operation);
  let results;
  const issue_id = operation.op === 'claim_acquire' ? operation.issue_id : operation.claim_proof.issue_id;
  try { results = await db.batch([...claimMutationStatements(operation, actor), claimObservation(issue_id)]); }
  catch (error) {
    if (!duplicateReceipt(error)) throw error;
    const row = (await db.reads.all(issueQueries.claimRequest, { request_id: operation.request_id }))[0];
    if (!row) throw new PolylinedbError('storage_error', 'Committed claim receipt is unavailable', 503);
    if (decideReplay(row, actor, payload) === 'request_conflict') throw new PolylinedbError('claim_request_conflict', 'The request ID belongs to a different actor, session, or payload', 409);
    return { claim_receipt: receipt(row) };
  }
  const row = results.at(-2)?.rows[0];
  if (row) return { claim_receipt: receipt(row) };
  const observed = results.at(-1)?.rows[0];
  if (!observed) throw new PolylinedbError('not_found', 'Issue was not found', 404, { id: issue_id });
  const current = inspection(observed);
  if (decideClaimMutation(current.lease, current.store_incarnation, operation, actor, current.observed_at).accepted) {
    throw new PolylinedbError('storage_error', 'The database rejected a claim mutation without a matching condition', 503);
  }
  throw new PolylinedbError('claim_conflict', 'Read the current claim before deciding on a new mutation', 409, { current });
}
function claimObservation(issue_id: string): SqlStatement {
  return { sql: `SELECT issues.id AS issue_id, identity.incarnation AS store_incarnation, CAST(unixepoch() AS INTEGER) AS observed_at, claim.incarnation, claim.actor,
    claim.session_id, claim.agent_label, claim.generation, claim.revision, claim.acquired_at, claim.changed_at, claim.expires_at, claim.released_at
    FROM issues CROSS JOIN memory_store_identity AS identity LEFT JOIN issue_claims AS claim ON claim.issue_id = issues.id
    WHERE identity.singleton = 1 AND issues.id = ?`, params: [issue_id] };
}
