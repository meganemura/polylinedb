// Owns issue operations and atomic SQL; transports and connection lifetimes stay outside.
import { fields, issueTypes, statuses } from './schema.ts';

export type Status = typeof statuses[number];
export type IssueType = typeof issueTypes[number];
export type Field = typeof fields[number];
export type Values = {
  tool: string; project: string; body: string; status: Status; type: IssueType;
  priority: number; labels: string[];
};
export type Change = { [K in Field]: { field: K; value: Values[K]; expected: number } }[Field];
type Filters = { tool?: string; project?: string; status?: Status; type?: IssueType;
  priority?: number; label?: string; after?: string; limit: number };
export type Operation =
  | ({ op: 'create'; parent?: string } & Values)
  | { op: 'show'; id: string }
  | ({ op: 'list' } & Filters)
  | ({ op: 'search'; query: string } & Filters)
  | { op: 'comment'; id: string; body: string }
  | { op: 'update'; id: string; changes: [Change, ...Change[]] }
  | { op: 'close' | 'reopen'; id: string; expected: number }
  | { op: 'actor' };
export type Issue = Values & { id: string; versions: Record<Field, number>;
  created_at: string; created_by: string; updated_at: string; updated_by: string };
export type Comment = { id: string; issue_id: string; body: string; created_at: string; created_by: string };
export type OperationResult = { issue: Issue } | { issue: Issue; comments: Comment[] }
  | { issues: Issue[]; next_cursor: string | null } | { comment: Comment } | { actor: string };
export type SqlStatement = { sql: string; params: readonly (string | number | null)[] };
export type SqlExecutor = { batch(statements: readonly SqlStatement[]): Promise<readonly { rows: readonly Record<string, unknown>[] }[]> };

export class PolylinedbError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'PolylinedbError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const invalid = (message: string): never => { throw new PolylinedbError('invalid_input', message); };
function object(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid(`${context} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return invalid(`${context} must be a plain object`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[] = []) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`Unknown field: ${key}`);
  for (const key of required) if (!Object.hasOwn(value, key)) invalid(`Missing field: ${key}`);
}
function text(value: unknown, name: string, maximum = 65536): string {
  if (typeof value !== 'string' || value.trim().length === 0) return invalid(`${name} must be a nonempty string`);
  if (new TextEncoder().encode(value).length > maximum) return invalid(`${name} exceeds ${maximum} UTF-8 bytes`);
  if (value.includes('\u0000')) return invalid(`${name} must not contain NUL`);
  return value;
}
function name(value: unknown, label: string): string {
  const result = text(value, label, 256);
  if (/\p{Cc}/u.test(result)) return invalid(`${label} must not contain control characters`);
  return result;
}
function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return invalid(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}
function enumeration<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== 'string') return invalid(`${label} must be one of ${allowed.join(', ')}`);
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) return invalid(`${label} must be one of ${allowed.join(', ')}`);
  return match;
}
function id(value: unknown, label = 'id'): string {
  const result = text(value, label, 300);
  const parts = result.split('.');
  if (parts.length > 8 || parts.some((part) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(part))) {
    return invalid(`${label} must contain one through eight UUID segments`);
  }
  return result;
}
function labels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) return invalid('labels must be an array of at most 64 names');
  return [...new Set(value.map((label) => name(label, 'label')))].sort();
}

const nameSchema = { type: 'string', minLength: 1, maxLength: 256, description: 'At most 256 UTF-8 bytes, without control characters.' };
const bodySchema = { type: 'string', minLength: 1, maxLength: 65536, description: 'At most 65536 UTF-8 bytes.' };
const versionSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const idSchema = { type: 'string', pattern: '^[0-9a-f-]+(\\.[0-9a-f-]+){0,7}$' };
const fieldRegistry = {
  tool: { column: 'tool', parse: (value: unknown) => name(value, 'tool'), schema: nameSchema },
  project: { column: 'project', parse: (value: unknown) => name(value, 'project'), schema: nameSchema },
  body: { column: 'body', parse: (value: unknown) => text(value, 'body'), schema: bodySchema },
  status: { column: 'status', parse: (value: unknown) => enumeration(value, 'status', statuses), schema: { type: 'string', enum: statuses } },
  type: { column: 'type', parse: (value: unknown) => enumeration(value, 'type', issueTypes), schema: { type: 'string', enum: issueTypes } },
  priority: { column: 'priority', parse: (value: unknown) => integer(value, 'priority', 0, 4), schema: { type: 'integer', minimum: 0, maximum: 4 } },
  labels: { column: 'labels_json', parse: labels, schema: { type: 'array', maxItems: 64, items: nameSchema } },
};
const objectSchema = (properties: Record<string, unknown>, required: readonly string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const valueSchemas = Object.fromEntries(fields.map((field) => [field, fieldRegistry[field].schema]));
const filterSchemas = { tool: nameSchema, project: nameSchema, status: fieldRegistry.status.schema,
  type: fieldRegistry.type.schema, priority: fieldRegistry.priority.schema, label: nameSchema,
  after: idSchema, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } };
export const operationSchemas = {
  create: objectSchema({ ...valueSchemas, parent: idSchema }, ['tool', 'project', 'body']),
  show: objectSchema({ id: idSchema }, ['id']),
  list: objectSchema(filterSchemas),
  search: objectSchema({ ...filterSchemas, query: bodySchema }, ['query']),
  comment: objectSchema({ id: idSchema, body: bodySchema }, ['id', 'body']),
  update: objectSchema({ id: idSchema, changes: { type: 'array', minItems: 1, maxItems: 7, items: {
    oneOf: fields.map((field) => objectSchema({ field: { const: field }, value: fieldRegistry[field].schema, expected: versionSchema }, ['field', 'value', 'expected']))
  } } }, ['id', 'changes']),
  close: objectSchema({ id: idSchema, expected: versionSchema }, ['id', 'expected']),
  reopen: objectSchema({ id: idSchema, expected: versionSchema }, ['id', 'expected']),
  actor: objectSchema({}),
};

function parseChange(value: unknown): Change {
  const input = object(value, 'change');
  keys(input, ['field', 'value', 'expected'], ['field', 'value', 'expected']);
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
export function parseOperation(value: unknown): Operation {
  const input = object(value, 'operation');
  const op = enumeration(input.op, 'op', ['create', 'show', 'list', 'search', 'comment', 'update', 'close', 'reopen', 'actor']);
  const schema = operationSchemas[op];
  keys(input, ['op', ...Object.keys(schema.properties)], ['op', ...schema.required]);
  switch (op) {
    case 'actor': return { op };
    case 'show': return { op, id: id(input.id) };
    case 'list': return { op, ...parseFilters(input) };
    case 'search': return { op, ...parseFilters(input), query: text(input.query, 'query') };
    case 'comment': return { op, id: id(input.id), body: text(input.body, 'body') };
    case 'close': case 'reopen': return { op, id: id(input.id), expected: integer(input.expected, 'expected', 1, Number.MAX_SAFE_INTEGER) };
    case 'create': {
      const parent = input.parent === undefined ? undefined : id(input.parent, 'parent');
      if (parent?.split('.').length === 8) invalid('An issue cannot have more than eight UUID segments');
      return { op, ...(parent === undefined ? {} : { parent }), tool: name(input.tool, 'tool'), project: name(input.project, 'project'),
        body: text(input.body, 'body'), status: input.status === undefined ? 'open' : fieldRegistry.status.parse(input.status),
        type: input.type === undefined ? 'task' : fieldRegistry.type.parse(input.type),
        priority: input.priority === undefined ? 2 : fieldRegistry.priority.parse(input.priority),
        labels: input.labels === undefined ? [] : labels(input.labels) };
    }
    case 'update': {
      if (!Array.isArray(input.changes) || input.changes.length === 0 || input.changes.length > 7) return invalid('changes must contain one through seven fields');
      const changes = input.changes.map(parseChange);
      const [first, ...rest] = changes;
      if (first === undefined) return invalid('changes must not be empty');
      if (new Set(changes.map((change) => change.field)).size !== changes.length) invalid('changes must not repeat a field');
      return { op, id: id(input.id), changes: [first, ...rest] };
    }
  }
}

function issueRow(row: Record<string, unknown>): Issue {
  try {
    const versions = Object.fromEntries(fields.map((field) => [field, integer(row[`${field}_v`], `${field} version`, 1, Number.MAX_SAFE_INTEGER)])) as Record<Field, number>;
    if (typeof row.labels_json !== 'string') throw new Error('labels_json is not text');
    return { id: id(row.id), tool: name(row.tool, 'tool'), project: name(row.project, 'project'), body: text(row.body, 'body'),
      status: enumeration(row.status, 'status', statuses), type: enumeration(row.type, 'type', issueTypes),
      priority: integer(row.priority, 'priority', 0, 4), labels: labels(JSON.parse(row.labels_json)), versions,
      created_at: text(row.created_at, 'created_at'), created_by: name(row.created_by, 'created_by'),
      updated_at: text(row.updated_at, 'updated_at'), updated_by: name(row.updated_by, 'updated_by') };
  } catch (error) {
    throw new PolylinedbError('invalid_store', `Stored issue is invalid: ${error instanceof Error ? error.message : 'invalid row'}`, 500);
  }
}
function commentRow(row: Record<string, unknown>): Comment {
  try { return { id: id(row.id), issue_id: id(row.issue_id), body: text(row.body, 'body'),
    created_at: text(row.created_at, 'created_at'), created_by: name(row.created_by, 'created_by') }; }
  catch { throw new PolylinedbError('invalid_store', 'Stored comment is invalid', 500); }
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
  EXISTS(SELECT 1 FROM issues AS child WHERE child.parent_id = issues.id) AS has_children
  FROM issues WHERE id = ?`, params: [issueId] });

async function update(db: SqlExecutor, issueId: string, changes: readonly Change[], actor: string): Promise<OperationResult> {
  const assignments: string[] = [];
  const conditions = ['id = ?'];
  const params: (string | number | null)[] = [];
  const guards: (string | number | null)[] = [issueId];
  for (const change of changes) {
    assignments.push(`${fieldRegistry[change.field].column} = ?`, `${change.field}_v = ${change.field}_v + 1`);
    params.push(change.field === 'labels' ? JSON.stringify(change.value) : change.value);
    conditions.push(`${change.field}_v = ?`, `${change.field}_v < 9007199254740991`);
    guards.push(change.expected);
    if (change.field === 'type' && change.value !== 'epic') conditions.push('NOT EXISTS(SELECT 1 FROM issues AS child WHERE child.parent_id = issues.id)');
  }
  assignments.push('updated_by = ?', 'updated_at = ?');
  params.push(actor, new Date().toISOString(), ...guards);
  const result = await db.batch([{ sql: `UPDATE issues SET ${assignments.join(', ')} WHERE ${conditions.join(' AND ')} RETURNING *`, params }, observation(issueId)]);
  const changed = rowsAt(result, 0)[0];
  if (changed) return { issue: issueRow(changed) };
  const observed = rowsAt(result, 1)[0];
  if (!observed) return notFound(issueId);
  const issue = issueRow(observed);
  const conflicts = changes.filter((change) => issue.versions[change.field] !== change.expected)
    .map((change) => ({ field: change.field, expected: change.expected, actual: issue.versions[change.field], current: issue[change.field] }));
  if (conflicts.length) throw new PolylinedbError('conflict', 'Read the current issue before deciding on a new update', 409, { issue, fields: conflicts });
  const exhausted = changes.find((change) => issue.versions[change.field] === Number.MAX_SAFE_INTEGER);
  if (exhausted) throw new PolylinedbError('version_exhausted', 'The field version cannot increase', 409, { field: exhausted.field, issue });
  if (observed.has_children === 1 && changes.some((change) => change.field === 'type' && change.value !== 'epic')) {
    throw new PolylinedbError('epic_has_children', 'An epic with children must remain an epic', 409, { issue });
  }
  throw new PolylinedbError('storage_error', 'The database rejected an update without a matching condition', 503);
}

export async function executeOperation(db: SqlExecutor, operation: Operation, actor: string): Promise<OperationResult> {
  if (operation.op === 'actor') return { actor: name(actor, 'actor') };
  if (!['show', 'list', 'search'].includes(operation.op)) name(actor, 'actor');
  switch (operation.op) {
    case 'create': {
      const issueId = (operation.parent ? `${operation.parent}.` : '') + crypto.randomUUID();
      const now = new Date().toISOString();
      const values = [issueId, operation.parent ?? null, operation.tool, operation.project, operation.body, operation.status, operation.type,
        operation.priority, JSON.stringify(operation.labels), now, actor, now, actor];
      const source = operation.parent ? 'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM issues WHERE id = ? AND type = \'epic\'' : 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
      const statements: SqlStatement[] = [{ sql: `INSERT INTO issues(id, parent_id, tool, project, body, status, type, priority, labels_json, created_at, created_by, updated_at, updated_by) ${source} RETURNING *`,
        params: operation.parent ? [...values, operation.parent] : values }];
      if (operation.parent) statements.push(observation(operation.parent));
      const result = await db.batch(statements);
      const row = rowsAt(result, 0)[0];
      if (row) return { issue: issueRow(row) };
      if (operation.parent && !rowsAt(result, 1)[0]) return notFound(operation.parent);
      throw new PolylinedbError('invalid_input', 'The parent must be an epic', 400);
    }
    case 'show': {
      const result = await db.batch([observation(operation.id), { sql: 'SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at, id', params: [operation.id] }]);
      const row = rowsAt(result, 0)[0];
      if (!row) return notFound(operation.id);
      return { issue: issueRow(row), comments: rowsAt(result, 1).map(commentRow) };
    }
    case 'comment': {
      const result = await db.batch([{ sql: `INSERT INTO comments(id, issue_id, body, created_at, created_by)
        SELECT ?, id, ?, ?, ? FROM issues WHERE id = ? RETURNING *`,
        params: [crypto.randomUUID(), operation.body, new Date().toISOString(), actor, operation.id] }]);
      const row = rowsAt(result, 0)[0];
      if (!row) return notFound(operation.id);
      return { comment: commentRow(row) };
    }
    case 'close': case 'reopen': return update(db, operation.id, [{ field: 'status', value: operation.op === 'close' ? 'closed' : 'open', expected: operation.expected }], actor);
    case 'update': return update(db, operation.id, operation.changes, actor);
    case 'list': case 'search': {
      const conditions: string[] = [];
      const params: (string | number | null)[] = [];
      for (const field of ['tool', 'project', 'status', 'type', 'priority'] as const) {
        if (operation[field] !== undefined) { conditions.push(`${field} = ?`); params.push(operation[field]); }
      }
      if (operation.label !== undefined) { conditions.push('EXISTS(SELECT 1 FROM json_each(issues.labels_json) WHERE value = ?)'); params.push(operation.label); }
      if (operation.after !== undefined) { conditions.push('issues.id > ?'); params.push(operation.after); }
      if (operation.op === 'search') { conditions.push('(instr(issues.body, ?) > 0 OR EXISTS(SELECT 1 FROM comments WHERE issue_id = issues.id AND instr(body, ?) > 0))'); params.push(operation.query, operation.query); }
      params.push(operation.limit + 1);
      const result = await db.batch([{ sql: `SELECT issues.* FROM issues ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY issues.id LIMIT ?`, params }]);
      const all = rowsAt(result, 0).map(issueRow);
      const issues = all.slice(0, operation.limit);
      return { issues, next_cursor: all.length > operation.limit ? issues[issues.length - 1]?.id ?? null : null };
    }
    default: { const unreachable: never = operation; return unreachable; }
  }
}
