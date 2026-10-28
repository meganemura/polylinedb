// Owns the change feed read: cursor validation, filters, and paging. Schema triggers own which writes record events.
import { PolylinedbError, requireFields } from '../store/errors.ts';
import { parseIssueId } from '../store/issue-id.ts';
import { issueQueries } from '../store/issue-queries.ts';
import { parseIncarnation } from '../claims/claims.ts';
import { changeKinds, changeRelations } from '../store/changes-sql.ts';
import type { ChangeKind } from '../store/changes-sql.ts';
import type { SqlExecutor } from '../store/sql.ts';

export type { ChangeKind };
type FeedFilter = { since: number; incarnation?: string; project?: string; issue_ids?: string[]; kinds?: ChangeKind[] };
export type ChangesOperation = FeedFilter & { op: 'changes'; limit: number };
export type WaitOperation = FeedFilter & { op: 'wait'; timeout: number };
/** relation names a non-prerequisite edge on dependency_added and dependency_removed; a prerequisite edge carries none. */
export type ChangeEvent = { seq: number; incarnation: string; issue_id: string; kind: string; fields: string[]; relation?: string; occurred_at: number; actor: string };
export type ChangesResult = { incarnation: string; changes: ChangeEvent[]; next_since: number };

const idSchema = { type: 'string', pattern: String.raw`^[a-z][a-z0-9]{0,15}-[1-9][0-9]*(\.[1-9][0-9]*){0,7}$` };
export const maximumIssueFilters = 50;
export const waitPollIntervalMs = 1000;
export const waitPageLimit = 50;
const feedProperties = {
  since: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'Return events after this seq. Start with 0, then pass next_since.' },
  incarnation: { type: 'string', pattern: '^[a-f0-9]{32}$', description: 'Required when since is greater than 0: the incarnation of the earlier page.' },
  project: { type: 'string', minLength: 1, maxLength: 256 },
  issue_ids: { type: 'array', items: idSchema, minItems: 1, maxItems: maximumIssueFilters, uniqueItems: true },
  kinds: { type: 'array', items: { type: 'string', enum: changeKinds }, minItems: 1, maxItems: changeKinds.length, uniqueItems: true },
};
export const changesSchemas = {
  changes: {
    type: 'object', additionalProperties: false, required: ['since'],
    properties: {
      ...feedProperties,
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    },
  },
  wait: {
    type: 'object', additionalProperties: false, required: ['since', 'timeout'],
    properties: {
      ...feedProperties,
      timeout: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'Seconds to wait. Required. There is no default.' },
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
function parseFeed(value: unknown, op: 'changes' | 'wait'): ChangesOperation | WaitOperation {
  const label = op === 'changes' ? 'Changes' : 'Wait';
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return invalid(`${label} input must be a plain object`);
  const input = value as Record<string, unknown>;
  const schema = changesSchemas[op];
  requireFields(input, ['op', ...Object.keys(schema.properties)], ['op', ...schema.required]);
  if (input.op !== op) return invalid(`Unknown ${op} operation`);
  const since = integer(input.since, 'since', 0);
  if (since > 0 && input.incarnation === undefined) return invalid('incarnation is required when since is greater than 0');
  const project = input.project;
  if (project !== undefined && (typeof project !== 'string' || !project.trim() || /\p{Cc}/u.test(project) || new TextEncoder().encode(project).length > 256)) return invalid('Invalid project');
  const filter: FeedFilter = {
    since,
    ...(input.incarnation === undefined ? {} : { incarnation: parseIncarnation(input.incarnation) }),
    ...(project === undefined ? {} : { project: project as string }),
    ...(input.issue_ids === undefined ? {} : { issue_ids: list(input.issue_ids, 'issue_ids', maximumIssueFilters, item => {
      try { return parseIssueId(item); } catch (error) { return invalid(error instanceof Error ? error.message : 'Invalid issue ID'); }
    }) }),
    ...(input.kinds === undefined ? {} : { kinds: list(input.kinds, 'kinds', changeKinds.length, item => changeKinds.find(kind => kind === item) ?? invalid(`kinds entries must be one of ${changeKinds.join(', ')}`)) }),
  };
  if (op === 'wait') return { op, ...filter, timeout: integer(input.timeout, 'timeout', 0) };
  return { op, ...filter, limit: input.limit === undefined ? 50 : integer(input.limit, 'limit', 1, 100) };
}
export function parseChangesOperation(value: unknown): ChangesOperation {
  const operation = parseFeed(value, 'changes');
  if (operation.op !== 'changes') return invalid('Unknown changes operation');
  return operation;
}
export function parseWaitOperation(value: unknown): WaitOperation {
  const operation = parseFeed(value, 'wait');
  if (operation.op !== 'wait') return invalid('Unknown wait operation');
  return operation;
}

function storedEvent(row: Record<string, unknown>, incarnation: string): ChangeEvent {
  try {
    const fields: unknown = typeof row.fields_json === 'string' ? JSON.parse(row.fields_json) : undefined;
    if (!Array.isArray(fields) || fields.some(field => typeof field !== 'string')) throw new Error('fields_json is not a list of names');
    const kind = changeKinds.find(kind => kind === row.kind);
    if (kind === undefined) throw new Error('kind is unknown');
    if (typeof row.actor !== 'string' || !row.actor) throw new Error('actor is empty');
    const relation = row.relation === null ? undefined : changeRelations.find(relation => relation === row.relation);
    if (row.relation !== null && relation === undefined) throw new Error('relation is unknown');
    return { seq: integer(row.seq, 'seq', 1), incarnation, issue_id: parseIssueId(row.issue_id), kind, fields, ...(relation === undefined ? {} : { relation }), occurred_at: integer(row.occurred_at, 'occurred_at', 0), actor: row.actor };
  } catch (error) {
    throw new PolylinedbError('invalid_store', `Stored change is invalid: ${error instanceof Error ? error.message : 'invalid row'}`, 500);
  }
}

// Checks a feed page's head row: the store incarnation, and that the cursor is neither ahead of the feed nor behind retention.
// A newest-first read passes no cursor and checks neither.
function feedHead(rows: Record<string, unknown>[], since: number | null, observed: string | undefined): { incarnation: string; latest: number } {
  const head = rows[0];
  if (!head) throw new PolylinedbError('storage_error', 'Database omitted the store incarnation', 503);
  const incarnation = parseIncarnation(head.store_incarnation);
  const latest = integer(head.latest_seq, 'latest_seq', 0); const oldest = integer(head.oldest_seq, 'oldest_seq', 0);
  if (observed !== undefined && observed !== incarnation) {
    throw new PolylinedbError('incarnation_mismatch', 'The store incarnation changed. Read the state again, then continue from next_since.', 409, { incarnation, next_since: latest });
  }
  if (since === null) return { incarnation, latest };
  if (since > latest) return invalid('since must not exceed the newest change seq');
  if (since < oldest - 1) {
    throw new PolylinedbError('cursor_expired', 'Retention removed changes after since. Read the state again, then continue from next_since.', 409, { incarnation, next_since: latest });
  }
  return { incarnation, latest };
}

export async function executeChangesOperation(db: SqlExecutor, operation: ChangesOperation): Promise<ChangesResult> {
  const rows = await db.reads.all(issueQueries.changes, { since: operation.since, project: operation.project ?? null,
    issue_ids: operation.issue_ids ?? [], kinds: operation.kinds ?? [], limit: operation.limit + 1 });
  const { incarnation, latest } = feedHead(rows, operation.since, operation.incarnation);
  const events = rows.filter(row => row.seq !== null).map(row => storedEvent(row, incarnation));
  const changes = events.slice(0, operation.limit);
  return { incarnation, changes, next_since: events.length > operation.limit ? changes.at(-1)?.seq ?? latest : latest };
}

/** A feed event with the issue's body and project, for the /ui activity page. */
export type ActivityEvent = ChangeEvent & { body: string; project: string };
export type ActivityPage = { incarnation: string; latest: number; events: ActivityEvent[]; more: boolean };

function activityEvent(row: Record<string, unknown>, incarnation: string): ActivityEvent {
  if (typeof row.body !== 'string' || typeof row.project !== 'string') throw new PolylinedbError('invalid_store', 'Stored change is invalid: issue text is missing', 500);
  return { ...storedEvent(row, incarnation), body: row.body, project: row.project };
}

/** Reads the newest events first, with their issues, in one query. */
export async function activityNewest(db: SqlExecutor, limit: number): Promise<ActivityPage> {
  const rows = await db.reads.all(issueQueries.activityNewest, { limit: limit + 1 });
  const { incarnation, latest } = feedHead(rows, null, undefined);
  const events = rows.filter(row => row.seq !== null).map(row => activityEvent(row, incarnation));
  return { incarnation, latest, events: events.slice(0, limit), more: events.length > limit };
}

/** Reads the events after a feed cursor, oldest first, with their issues, in one query. It validates the cursor like `changes`. */
export async function activityAfter(db: SqlExecutor, since: number, incarnation: string, limit: number): Promise<ActivityPage> {
  const rows = await db.reads.all(issueQueries.activityAfter, { since, limit: limit + 1 });
  const head = feedHead(rows, since, incarnation);
  const events = rows.filter(row => row.seq !== null).map(row => activityEvent(row, head.incarnation));
  return { ...head, events: events.slice(0, limit), more: events.length > limit };
}

/** Event counts per actor and kind over the last `seconds` by the store clock, most events first. Retention may have removed older events. */
export type ActivityCount = { actor: string; kind: string; events: number };
export async function activitySince(db: SqlExecutor, seconds: number): Promise<ActivityCount[]> {
  return (await db.reads.all(issueQueries.activitySince, { seconds })).map(row => {
    if (typeof row.actor !== 'string' || typeof row.kind !== 'string' || typeof row.events !== 'number') throw new PolylinedbError('invalid_store', 'Stored change count is invalid', 500);
    return { actor: row.actor, kind: row.kind, events: row.events };
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

export async function executeWaitOperation(db: SqlExecutor, operation: WaitOperation): Promise<ChangesResult> {
  const deadline = Date.now() + operation.timeout * 1000;
  const read = () => executeChangesOperation(db, {
    op: 'changes', since: operation.since, limit: waitPageLimit,
    ...(operation.incarnation === undefined ? {} : { incarnation: operation.incarnation }),
    ...(operation.project === undefined ? {} : { project: operation.project }),
    ...(operation.issue_ids === undefined ? {} : { issue_ids: operation.issue_ids }),
    ...(operation.kinds === undefined ? {} : { kinds: operation.kinds }),
  });
  while (true) {
    const page = await read();
    if (page.changes.length > 0) return page;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return page;
    await sleep(Math.min(waitPollIntervalMs, remaining));
  }
}
