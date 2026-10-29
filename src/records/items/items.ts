// Owns the item operations: adding an ask or a check to an issue, and resolving one. The rules live in transition/items.ts,
// the row shape and the close gate in store/issue-items.ts, and the DDL in items-sql.ts.
import { parseIssueId, parseRequestId } from '../store/issue-id.ts';
import { knownError, PolylinedbError, requireFields } from '../store/errors.ts';
import { recordingChanges } from '../store/changes-sql.ts';
import { issueItemsRead, itemRow } from '../store/issue-items.ts';
import type { Item } from '../store/issue-items.ts';
import { agentHoldsClaim, heldClaimObservation, rejectAgentWrite } from '../claims/agent-gate.ts';
import type { SqlExecutor, SqlStatement } from '../store/sql.ts';
import { decideItemMove, itemKinds, itemStates } from '../../transition/index.ts';
import type { Actor, ItemKind, MoveSurface, ResolvedState } from '../../transition/index.ts';

export type ItemAdd = { op: 'item_add'; id: string; kind: ItemKind; text: string; options?: string[]; recommended?: string; request_id: string };
/** `surface` is set only by the /ui page, never parsed from input. */
export type ItemResolve = { op: 'item_resolve'; id: string; n: number; to: ResolvedState; answer?: string; note?: string; surface?: MoveSurface };
export type ItemOperation = ItemAdd | ItemResolve;
/** item_add adds `wait_from`, the feed position just after the add: wait from it with kind answered to wake only on an answer. */
export type ItemResult = { id: string; item: Item; items: Item[]; wait_from?: { incarnation: string; since: number } };

const resolvedStates = itemStates.filter((state): state is ResolvedState => state !== 'open');
const idSchema = { type: 'string', pattern: String.raw`^[a-z][a-z0-9]{0,15}-[1-9][0-9]*(\.[1-9][0-9]*){0,7}$` };
const textLimit = 4096;
const optionLimit = 200;
export const itemSchemas = {
  item_add: { type: 'object', additionalProperties: false, required: ['id', 'kind', 'text', 'request_id'], properties: {
    id: idSchema,
    kind: { type: 'string', enum: itemKinds, description: 'ask: a question a person answers once; while it is open the issue is off the ready worklist, listed in owner waits, and cannot close or be handed off. check: an acceptance condition; while it is unmet the issue cannot close or be handed off.' },
    text: { type: 'string', minLength: 1, maxLength: textLimit, description: 'The question, or the condition that must hold.' },
    options: { type: 'array', items: { type: 'string', minLength: 1, maxLength: optionLimit }, minItems: 2, maxItems: 8, uniqueItems: true, description: 'ask only: the answers a person picks from. Without options the answer is free text.' },
    recommended: { type: 'string', minLength: 1, maxLength: optionLimit, description: 'ask only: the option you recommend, one of options.' },
    request_id: { type: 'string', format: 'uuid', description: 'A new UUID for this add. A retry with the same UUID and arguments returns the same item.' } } },
  item_resolve: { type: 'object', additionalProperties: false, required: ['id', 'n', 'to'], properties: {
    id: idSchema,
    n: { type: 'integer', minimum: 1, description: 'The item number that show, item_add, or the items_open refusal names.' },
    to: { type: 'string', enum: resolvedStates, description: 'answered: a person answers an ask (not the actor that asked, and not an agent). withdrawn: the actor that asked, or a person, drops an ask, with a reason in note. met: a check holds, with the evidence in note. waived: a person drops a check, with the reason in note.' },
    answer: { type: 'string', minLength: 1, maxLength: textLimit, description: 'answered only: one of the options, or the free answer when the ask has none.' },
    note: { type: 'string', minLength: 1, maxLength: textLimit, description: 'The evidence for met, the reason for waived or withdrawn, or an optional comment on an answer.' } } },
};

const invalid = (message: string): never => { throw new PolylinedbError('invalid_input', message); };
function text(value: unknown, label: string, limit: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\u0000') || new TextEncoder().encode(value).length > limit) return invalid(`${label} must be 1 through ${limit} UTF-8 bytes`);
  return value;
}
function issueId(value: unknown): string {
  try { return parseIssueId(value); } catch (error) { return invalid(error instanceof Error ? error.message : 'Invalid id'); }
}

export function parseItemOperation(value: unknown): ItemOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Item input must be a plain object');
  const input = value as Record<string, unknown>;
  if (input.op === 'item_add') {
    requireFields(input, ['op', ...Object.keys(itemSchemas.item_add.properties)], ['op', ...itemSchemas.item_add.required]);
    const kind = itemKinds.find(candidate => candidate === input.kind) ?? invalid(`kind must be one of ${itemKinds.join(', ')}`);
    if (kind !== 'ask' && (input.options !== undefined || input.recommended !== undefined)) return invalid('Only an ask takes options and recommended');
    let request_id: string;
    try { request_id = parseRequestId(input.request_id); } catch (error) { return invalid(error instanceof Error ? error.message : 'Invalid request_id'); }
    const options = input.options === undefined ? undefined : Array.isArray(input.options) && input.options.length >= 2 && input.options.length <= 8
      ? input.options.map(option => text(option, 'Each option', optionLimit)) : invalid('options must list 2 through 8 answers');
    if (options !== undefined && (new Set(options).size !== options.length || options.some(option => /\p{Cc}/u.test(option)))) return invalid('options must be distinct single lines');
    const recommended = input.recommended === undefined ? undefined : text(input.recommended, 'recommended', optionLimit);
    if (recommended !== undefined && !options?.includes(recommended)) return invalid('recommended must be one of options');
    return { op: 'item_add', id: issueId(input.id), kind, text: text(input.text, 'text', textLimit),
      ...(options === undefined ? {} : { options }), ...(recommended === undefined ? {} : { recommended }), request_id };
  }
  if (input.op !== 'item_resolve') return invalid('Unknown item operation');
  requireFields(input, ['op', ...Object.keys(itemSchemas.item_resolve.properties)], ['op', ...itemSchemas.item_resolve.required]);
  const n = typeof input.n === 'number' && Number.isSafeInteger(input.n) && input.n >= 1 ? input.n : invalid('n must name an item');
  const to = resolvedStates.find(state => state === input.to) ?? invalid(`to must be one of ${resolvedStates.join(', ')}`);
  return { op: 'item_resolve', id: issueId(input.id), n, to,
    ...(input.answer === undefined ? {} : { answer: text(input.answer, 'answer', textLimit) }),
    ...(input.note === undefined ? {} : { note: text(input.note, 'note', textLimit) }) };
}

const issueObservation = (id: string): SqlStatement => ({ sql: 'SELECT status, labels_json FROM issues WHERE id = ?', params: [id] });
const feedPosition: SqlStatement = { sql: 'SELECT incarnation, (SELECT COALESCE(MAX(seq), 0) FROM change_events) AS since FROM memory_store_identity WHERE singleton = 1', params: [] };
const issueOpen = "EXISTS(SELECT 1 FROM issues WHERE id = ? AND status <> 'closed')";

function items(rows: readonly Record<string, unknown>[] | undefined): Item[] {
  return (rows ?? []).map(row => { const { issue_id: _, ...item } = itemRow(row); return item; });
}
function waitFrom(row: Record<string, unknown> | undefined): { incarnation: string; since: number } {
  if (!row || typeof row.incarnation !== 'string' || typeof row.since !== 'number') throw new PolylinedbError('storage_error', 'Database omitted the feed position', 503);
  return { incarnation: row.incarnation, since: row.since };
}
function refuse(issueId: string, caller: Actor, issue: Record<string, unknown> | undefined, claim: Record<string, unknown> | undefined): never {
  if (!issue) throw new PolylinedbError('not_found', 'Issue was not found', 404, { id: issueId });
  if (issue.status === 'closed') throw new PolylinedbError('conflict', 'A closed issue takes no item changes; reopen it first', 409, { id: issueId });
  rejectAgentWrite(caller, 'issue_write', issueId, JSON.parse(String(issue.labels_json)), claim);
  throw new PolylinedbError('storage_error', 'The database rejected an item write without a matching condition', 503);
}

async function add(db: SqlExecutor, operation: ItemAdd, caller: Actor): Promise<ItemResult> {
  const gate = agentHoldsClaim(operation.id, caller);
  const options = operation.options === undefined ? null : JSON.stringify(operation.options);
  let results;
  try {
    results = await recordingChanges(db, caller.id).batch([
      { sql: `INSERT INTO issue_items(issue_id,n,kind,text,options_json,recommended,state,request_id,created_at,created_by)
        SELECT ?, COALESCE((SELECT MAX(n) FROM issue_items WHERE issue_id = ?), 0) + 1, ?, ?, ?, ?, 'open', ?, ?, ? WHERE ${issueOpen} AND ${gate.sql} RETURNING *`,
      params: [operation.id, operation.id, operation.kind, operation.text, options, operation.recommended ?? null, operation.request_id, new Date().toISOString(), caller.id, operation.id, ...gate.params] },
      issueObservation(operation.id), heldClaimObservation(operation.id), feedPosition, issueItemsRead(operation.id)]);
  } catch (error) {
    if (!knownError(error, 'UNIQUE constraint failed: issue_items.request_id')) throw error;
    return replayAdd(db, operation, caller);
  }
  const added = results[0]?.rows[0];
  if (!added) return refuse(operation.id, caller, results[1]?.rows[0], results[2]?.rows[0]);
  const { issue_id: _, ...item } = itemRow(added);
  return { id: operation.id, item, items: items(results[4]?.rows), wait_from: waitFrom(results[3]?.rows[0]) };
}

// The stored row is the receipt: a replay must name the same actor, issue, and item as the add that wrote it.
async function replayAdd(db: SqlExecutor, operation: ItemAdd, caller: Actor): Promise<ItemResult> {
  const [stored, position] = await db.batch([{ sql: 'SELECT * FROM issue_items WHERE request_id = ?', params: [operation.request_id] }, feedPosition]);
  const row = stored?.rows[0];
  if (!row) throw new PolylinedbError('storage_error', 'Committed item is unavailable', 503);
  const { issue_id, ...item } = itemRow(row);
  const same = issue_id === operation.id && item.created_by === caller.id && item.kind === operation.kind && item.text === operation.text
    && JSON.stringify(item.options) === JSON.stringify(operation.options ?? null) && item.recommended === (operation.recommended ?? null);
  if (!same) throw new PolylinedbError('item_request_conflict', 'The request ID belongs to a different actor, issue, or item', 409);
  const [current] = await db.batch([issueItemsRead(operation.id)]);
  return { id: operation.id, item, items: items(current?.rows), wait_from: waitFrom(position?.rows[0]) };
}

async function resolve(db: SqlExecutor, operation: ItemResolve, caller: Actor): Promise<ItemResult> {
  const named = { id: operation.id, n: operation.n };
  const decide = (row: Record<string, unknown> | undefined) => {
    if (!row) throw new PolylinedbError('item_not_found', 'Item was not found on this issue', 404, named);
    const { issue_id: _, ...item } = itemRow(row);
    const decision = decideItemMove(item, { to: operation.to, ...(operation.answer === undefined ? {} : { answer: operation.answer }), ...(operation.note === undefined ? {} : { note: operation.note }) },
      caller, operation.surface ?? 'operation');
    if (decision.accepted) return { item, unchanged: decision.unchanged };
    const { code, message } = decision.rejection;
    if (code === 'invalid_input') return invalid(message);
    throw new PolylinedbError(code, message, code === 'item_actor_refused' ? 403 : 409, code === 'item_conflict' ? { ...named, item } : named);
  };
  const itemRead: SqlStatement = { sql: 'SELECT * FROM issue_items WHERE issue_id = ? AND n = ?', params: [operation.id, operation.n] };
  const [issue, observed, listed] = await db.batch([issueObservation(operation.id), itemRead, issueItemsRead(operation.id)]);
  if (!issue?.rows[0]) throw new PolylinedbError('not_found', 'Issue was not found', 404, { id: operation.id });
  const before = decide(observed?.rows[0]);
  if (before.unchanged) return { id: operation.id, item: before.item, items: items(listed?.rows) };
  const gate = agentHoldsClaim(operation.id, caller);
  const results = await recordingChanges(db, caller.id).batch([
    { sql: `UPDATE issue_items SET state = ?, answer = ?, note = ?, resolved_at = ?, resolved_by = ?
      WHERE issue_id = ? AND n = ? AND state = 'open' AND ${issueOpen} AND ${gate.sql} RETURNING *`,
    params: [operation.to, operation.answer ?? null, operation.note ?? null, new Date().toISOString(), caller.id, operation.id, operation.n, operation.id, ...gate.params] },
    issueObservation(operation.id), heldClaimObservation(operation.id), itemRead, issueItemsRead(operation.id)]);
  const moved = results[0]?.rows[0];
  if (moved) { const { issue_id: _, ...item } = itemRow(moved); return { id: operation.id, item, items: items(results[4]?.rows) }; }
  const current = results[1]?.rows[0];
  if (current && current.status !== 'closed') {
    rejectAgentWrite(caller, 'issue_write', operation.id, JSON.parse(String(current.labels_json)), results[2]?.rows[0]);
    // Another writer resolved the item between the read and the write.
    const after = decide(results[3]?.rows[0]);
    if (after.unchanged) return { id: operation.id, item: after.item, items: items(results[4]?.rows) };
  }
  return refuse(operation.id, caller, current, results[2]?.rows[0]);
}

export function executeItemOperation(db: SqlExecutor, operation: ItemOperation, caller: Actor): Promise<ItemResult> {
  return operation.op === 'item_add' ? add(db, operation, caller) : resolve(db, operation, caller);
}
