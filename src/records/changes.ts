// Owns the change feed read: cursor validation, filters, and paging. Schema triggers own which writes record events.
import { PolylinedbError, requireFields } from './errors.ts';
import { parseIssueId } from './issue-id.ts';
import { issueQueries } from './issue-queries.ts';
import { parseIncarnation } from './claims.ts';
import { changeKinds } from './changes-sql.ts';
import type { ChangeKind } from './changes-sql.ts';
import type { SqlExecutor } from './issues.ts';

export type { ChangeKind };
export type ChangesOperation = { op: 'changes'; since: number; incarnation?: string; project?: string; issue_ids?: string[]; kinds?: ChangeKind[]; limit: number };
export type ChangeEvent = { seq: number; incarnation: string; issue_id: string; kind: string; fields: string[]; occurred_at: number; actor: string };
export type ChangesResult = { incarnation: string; changes: ChangeEvent[]; next_since: number };

const idSchema = { type: 'string', pattern: String.raw`^[a-z][a-z0-9]{0,15}-[1-9][0-9]*(\.[1-9][0-9]*){0,7}$` };
export const maximumIssueFilters = 50;
export const changesSchemas = {
  changes: {
    type: 'object', additionalProperties: false, required: ['since'],
    properties: {
      since: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'Return events after this seq. Start with 0, then pass next_since.' },
      incarnation: { type: 'string', pattern: '^[a-f0-9]{32}$', description: 'Required when since is greater than 0: the incarnation of the earlier page.' },
      project: { type: 'string', minLength: 1, maxLength: 256 },
      issue_ids: { type: 'array', items: idSchema, minItems: 1, maxItems: maximumIssueFilters, uniqueItems: true },
      kinds: { type: 'array', items: { type: 'string', enum: changeKinds }, minItems: 1, maxItems: changeKinds.length, uniqueItems: true },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    },
  },
};

const invalid = (message: string): never => { throw new PolylinedbError('invalid_input', message); };
function integer(value: unknown, name: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid(`${name} must be an integer from ${minimum} through ${maximum}`);
  return value;
}
function list<T>(value: unknown, name: string, maximum: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) return invalid(`${name} must be an array of 1 through ${maximum} entries`);
  const items = value.map(parse);
  if (new Set(items).size !== items.length) return invalid(`${name} must not repeat an entry`);
  return items;
}
export function parseChangesOperation(value: unknown): ChangesOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return invalid('Changes input must be a plain object');
  const input = value as Record<string, unknown>;
  const schema = changesSchemas.changes;
  requireFields(input, ['op', ...Object.keys(schema.properties)], ['op', ...schema.required]);
  if (input.op !== 'changes') return invalid('Unknown changes operation');
  const since = integer(input.since, 'since', 0);
  if (since > 0 && input.incarnation === undefined) return invalid('incarnation is required when since is greater than 0');
  const project = input.project;
  if (project !== undefined && (typeof project !== 'string' || !project.trim() || /\p{Cc}/u.test(project) || new TextEncoder().encode(project).length > 256)) return invalid('Invalid project');
  return {
    op: 'changes', since,
    ...(input.incarnation === undefined ? {} : { incarnation: parseIncarnation(input.incarnation) }),
    ...(project === undefined ? {} : { project: project as string }),
    ...(input.issue_ids === undefined ? {} : { issue_ids: list(input.issue_ids, 'issue_ids', maximumIssueFilters, item => {
      try { return parseIssueId(item); } catch (error) { return invalid(error instanceof Error ? error.message : 'Invalid issue ID'); }
    }) }),
    ...(input.kinds === undefined ? {} : { kinds: list(input.kinds, 'kinds', changeKinds.length, item => changeKinds.find(kind => kind === item) ?? invalid(`kinds entries must be one of ${changeKinds.join(', ')}`)) }),
    limit: input.limit === undefined ? 50 : integer(input.limit, 'limit', 1, 100),
  };
}

function storedEvent(row: Record<string, unknown>, incarnation: string): ChangeEvent {
  try {
    const fields: unknown = typeof row.fields_json === 'string' ? JSON.parse(row.fields_json) : undefined;
    if (!Array.isArray(fields) || fields.some(field => typeof field !== 'string')) throw new Error('fields_json is not a list of names');
    const kind = changeKinds.find(kind => kind === row.kind);
    if (kind === undefined) throw new Error('kind is unknown');
    if (typeof row.actor !== 'string' || !row.actor) throw new Error('actor is empty');
    return { seq: integer(row.seq, 'seq', 1), incarnation, issue_id: parseIssueId(row.issue_id), kind, fields, occurred_at: integer(row.occurred_at, 'occurred_at', 0), actor: row.actor };
  } catch (error) {
    throw new PolylinedbError('invalid_store', `Stored change is invalid: ${error instanceof Error ? error.message : 'invalid row'}`, 500);
  }
}

export async function executeChangesOperation(db: SqlExecutor, operation: ChangesOperation): Promise<ChangesResult> {
  const rows = await db.reads.all(issueQueries.changes, { since: operation.since, project: operation.project ?? null,
    issue_ids: operation.issue_ids ?? [], kinds: operation.kinds ?? [], limit: operation.limit + 1 });
  const head = rows[0];
  if (!head) throw new PolylinedbError('storage_error', 'Database omitted the store incarnation', 503);
  const incarnation = parseIncarnation(head.store_incarnation);
  const latest = head.latest_seq; const oldest = head.oldest_seq;
  if (operation.incarnation !== undefined && operation.incarnation !== incarnation) {
    throw new PolylinedbError('incarnation_mismatch', 'The store incarnation changed. Read the state again, then continue from next_since.', 409, { incarnation, next_since: latest });
  }
  if (operation.since > latest) return invalid('since must not exceed the newest change seq');
  if (operation.since < oldest - 1) {
    throw new PolylinedbError('cursor_expired', 'Retention removed changes after since. Read the state again, then continue from next_since.', 409, { incarnation, next_since: latest });
  }
  const events = rows.filter(row => row.seq !== null).map(row => storedEvent(row, incarnation));
  const changes = events.slice(0, operation.limit);
  return { incarnation, changes, next_since: events.length > operation.limit ? changes.at(-1)?.seq ?? latest : latest };
}
