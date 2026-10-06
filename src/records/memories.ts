// Owns current project knowledge, its write conflicts, and bounded retrieval; hosts own invocation and identity.
import { PolylinedbError } from "./errors.ts";
import type { SqlExecutor, SqlStatement } from "./issues.ts";
import { parsePrefix, parseRequestId } from "./issue-id.ts";
import { issueQueries } from "./issue-queries.ts";
import { statements } from "./solarsql.generated.ts";

export type Memory = { id: string; project: string; title: string; body: string; version: number;
  created_at: string; created_by: string; updated_at: string; updated_by: string };
export type MemoryStore = { kind: 'local'; database_path: string } | { kind: 'cloud'; url: string };
type Scope = { project: string };
type Page = Scope & { after?: string; limit: number };
export type MemoryOperation =
  | (Scope & { op: 'memory_create'; prefix: string; request_id: string; title: string; body: string })
  | (Scope & { op: 'memory_show'; id: string })
  | (Page & { op: 'memory_list' })
  | (Page & { op: 'memory_search'; query: string })
  | (Scope & { op: 'memory_update'; id: string; title: string; body: string; expected: number })
  | (Scope & { op: 'memory_delete'; id: string; expected: number })
  | (Page & { op: 'memory_context'; max_bytes: number; with_revision?: true });
export type MemoryContext = { project: string; store: MemoryStore; memories: Memory[];
  limits: { entries: number; bytes: number }; omitted: boolean; next_cursor: string | null;
  notices: { code: 'entry_limit' | 'byte_limit'; skipped_id?: string }[]; memory_revision?: MemoryRevision };
export type MemoryRevision = string & { readonly __brand: 'MemoryRevision' };
export type MemoryFreshness =
  | { status: 'current'; project: string }
  | { status: 'stale'; project: string; reason: 'memory_changed' | 'project_changed' | 'store_changed' }
  | { status: 'unavailable'; project: string };
type RevisionObservation = { store: MemoryStore; incarnation: string; project: string; revision: number };
export type MemoryResult = { memory: Memory } | { memories: Memory[]; next_cursor: string | null }
  | { deleted: { id: string; project: string; version: number } } | MemoryContext;
export type MemoryCounter = { prefix: string; last_number: number };
export type MemoryRequest = { request_id: string; actor: string; payload: string; memory_id: string };
const invalid = (message: string): never => { throw new PolylinedbError('invalid_input', message, 400); };
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
function text(value: unknown, label: string, bytes: number): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || new TextEncoder().encode(value).length > bytes) return invalid(`Invalid ${label}; use 1 through ${bytes} UTF-8 bytes`);
  return value;
}
function name(value: unknown, label: string): string {
  const result = text(value, label, 256);
  if (/\p{Cc}/u.test(result)) return invalid(`Invalid ${label}`);
  return result;
}
function integer(value: unknown, label: string, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid(`Invalid ${label}; use an integer from ${min} through ${max}`);
  return value;
}
export function parseMemoryId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9]{0,15}-m[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value.slice(value.indexOf('-m') + 2)))) return invalid('Invalid memory ID');
  return value;
}
export function memorySortKey(value: string): string {
  const id = parseMemoryId(value);
  const separator = id.indexOf('-m');
  return id.slice(0, separator + 2) + id.slice(separator + 2).padStart(16, '0');
}
const nameSchema = { type: 'string', minLength: 1, maxLength: 256, description: 'At most 256 UTF-8 bytes; no control characters.' };
const bodySchema = { type: 'string', minLength: 1, maxLength: 16384, description: 'At most 16384 UTF-8 bytes.' };
const idSchema = { type: 'string', pattern: '^[a-z][a-z0-9]{0,15}-m[1-9][0-9]*$' };
const versionSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const pageSchema = { project: nameSchema, after: idSchema, limit: { type: 'integer', minimum: 1, maximum: 100 } };
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
export const memorySchemas = {
  memory_create: schema({ project: nameSchema, prefix: { type: 'string', pattern: '^[a-z][a-z0-9]{0,15}$' }, request_id: { type: 'string', format: 'uuid', description: 'Generate one lowercase UUID per logical creation. Retain it and reuse it unchanged on an explicit retry.' }, title: nameSchema, body: bodySchema }, ['project', 'prefix', 'request_id', 'title', 'body']),
  memory_show: schema({ project: nameSchema, id: idSchema }, ['project', 'id']),
  memory_list: schema(pageSchema, ['project']),
  memory_search: schema({ ...pageSchema, query: bodySchema }, ['project', 'query']),
  memory_update: schema({ project: nameSchema, id: idSchema, title: nameSchema, body: bodySchema, expected: versionSchema }, ['project', 'id', 'title', 'body', 'expected']),
  memory_delete: schema({ project: nameSchema, id: idSchema, expected: versionSchema }, ['project', 'id', 'expected']),
  memory_context: schema({ ...pageSchema, max_bytes: { type: 'integer', minimum: 4096, maximum: 65536, default: 32768 }, with_revision: { const: true, type: 'boolean' } }, ['project']),
};
export function parseMemoryOperation(value: unknown): MemoryOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Memory operation must be an object');
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return invalid('Memory operation must be a plain object');
  const input = value as Record<string, unknown>;
  const op = Object.keys(memorySchemas).find(key => key === input.op);
  if (!op) return invalid('Unknown memory operation');
  const definition = memorySchemas[op as keyof typeof memorySchemas];
  if (Object.keys(input).some(key => key !== 'op' && !Object.hasOwn(definition.properties, key)) || definition.required.some(key => !Object.hasOwn(input, key))) return invalid('Unexpected or missing memory operation fields');
  const project = name(input.project, 'project');
  const page = () => ({ project, ...(input.after === undefined ? {} : { after: parseMemoryId(input.after) }), limit: input.limit === undefined ? (op === 'memory_context' ? 20 : 50) : integer(input.limit, 'limit', 1, 100) });
  switch (op) {
    case 'memory_create': {
      let prefix: string, request_id: string;
      try { prefix = parsePrefix(input.prefix); request_id = parseRequestId(input.request_id); } catch (error) { return invalid(error instanceof Error ? error.message : 'Invalid creation identifier'); }
      return { op, project, prefix, request_id, title: name(input.title, 'title'), body: text(input.body, 'body', 16384) };
    }
    case 'memory_show': return { op, project, id: parseMemoryId(input.id) };
    case 'memory_list': return { op, ...page() };
    case 'memory_search': return { op, ...page(), query: text(input.query, 'query', 16384) };
    case 'memory_context': {
      if (input.with_revision !== undefined && input.with_revision !== true) return invalid('with_revision must be true when supplied');
      return { op, ...page(), max_bytes: input.max_bytes === undefined ? 32768 : integer(input.max_bytes, 'max_bytes', 4096, 65536), ...(input.with_revision === true ? { with_revision: true } : {}) };
    }
    case 'memory_update': return { op, project, id: parseMemoryId(input.id), title: name(input.title, 'title'), body: text(input.body, 'body', 16384), expected: integer(input.expected, 'expected') };
    case 'memory_delete': return { op, project, id: parseMemoryId(input.id), expected: integer(input.expected, 'expected') };
    default: return invalid('Unknown memory operation');
  }
}
export function memoryRow(row: Record<string, unknown>): Memory {
  try {
    return { id: parseMemoryId(row.id), project: name(row.project, 'project'), title: name(row.title, 'title'), body: text(row.body, 'body', 16384), version: integer(row.version, 'version'),
      created_at: name(row.created_at, 'created_at'), created_by: name(row.created_by, 'created_by'), updated_at: name(row.updated_at, 'updated_at'), updated_by: name(row.updated_by, 'updated_by') };
  } catch { throw new PolylinedbError('invalid_store', 'Invalid stored memory', 500); }
}
const observation = (project: string, id: string): SqlStatement => ({ sql: 'SELECT * FROM memories WHERE project = ? AND id = ?', params: [project, id] });
const missing = (project: string, id: string): never => { throw new PolylinedbError('memory_not_found', 'Memory not found in this project', 404, { project, id }); };
function memoryWriteFailure(error: unknown): never {
  if (error instanceof Error && error.message.includes('memory_revision_not_exhausted')) throw new PolylinedbError('memory_revision_exhausted', 'Project memory revision reached its limit', 409);
  throw error;
}

function contextPage(operation: Extract<MemoryOperation, { op: 'memory_context' }>, rows: Memory[], store: MemoryStore, revision?: MemoryRevision): MemoryContext {
  const available = rows.slice(0, operation.limit);
  const output: MemoryContext = { project: operation.project, store, memories: available, limits: { entries: operation.limit, bytes: operation.max_bytes }, omitted: rows.length > operation.limit,
    next_cursor: rows.length > operation.limit ? available.at(-1)?.id ?? null : null, notices: rows.length > operation.limit ? [{ code: 'entry_limit' }] : [], ...(revision === undefined ? {} : { memory_revision: revision }) };
  while (encode(output) > operation.max_bytes && output.memories.length) {
    output.memories.pop();
    output.omitted = true;
    output.notices = [{ code: 'byte_limit' }];
    output.next_cursor = output.memories.at(-1)?.id ?? null;
  }
  if (!output.memories.length && rows.length) {
    output.omitted = true;
    output.next_cursor = rows[0].id;
    output.notices = [{ code: 'byte_limit', skipped_id: rows[0].id }];
  }
  if (encode(output) > operation.max_bytes) throw new PolylinedbError('context_identity_too_large', 'Store identity exceeds the context byte limit', 400);
  return output;
}

export async function executeMemoryOperation(db: SqlExecutor, operation: MemoryOperation, actor: string, store?: MemoryStore): Promise<MemoryResult> {
  if (['memory_create', 'memory_update', 'memory_delete'].includes(operation.op)) name(actor, 'actor');
  switch (operation.op) {
    case 'memory_create': {
      const payload = JSON.stringify(parseMemoryOperation(operation));
      const now = new Date().toISOString();
      const gate = 'NOT EXISTS (SELECT 1 FROM memory_requests WHERE request_id = ?)';
      const result = await db.batch([
        { sql: `INSERT INTO memory_counters(prefix,last_number) SELECT ?,1 WHERE ${gate} ON CONFLICT(prefix) DO UPDATE SET last_number = last_number + 1`, params: [operation.prefix, operation.request_id] },
        { sql: `INSERT INTO memories(id,sort_key,project,title,body,version,created_at,created_by,updated_at,updated_by) SELECT ? || last_number, ? || printf('%016d',last_number), ?,?,?,1,?,?,?,? FROM memory_counters WHERE prefix = ? AND ${gate}`, params: [`${operation.prefix}-m`, `${operation.prefix}-m`, operation.project, operation.title, operation.body, now, actor, now, actor, operation.prefix, operation.request_id] },
        { sql: `INSERT INTO memory_requests(request_id,actor,payload,memory_id) SELECT ?,?,?,? || last_number FROM memory_counters WHERE prefix = ? AND ${gate}`, params: [operation.request_id, actor, payload, `${operation.prefix}-m`, operation.prefix, operation.request_id] },
        { sql: 'SELECT * FROM memory_requests WHERE request_id = ?', params: [operation.request_id] },
        { sql: 'SELECT memories.* FROM memories JOIN memory_requests ON memories.id = memory_requests.memory_id WHERE request_id = ?', params: [operation.request_id] },
      ]).catch((error: unknown) => {
        if (error instanceof Error && error.message.includes('memory_counter_not_exhausted')) throw new PolylinedbError('counter_exhausted', 'Memory counter reached its limit', 409);
        return memoryWriteFailure(error);
      });
      const request = result[3]?.rows[0];
      if (!request) throw new PolylinedbError('storage_error', 'Missing memory creation receipt', 503);
      if (request.actor !== actor || request.payload !== payload) throw new PolylinedbError('request_conflict', 'Request belongs to another actor or payload', 409);
      const row = result[4]?.rows[0];
      if (!row) throw new PolylinedbError('memory_deleted', 'The previously created memory was deleted', 409, { project: operation.project, id: parseMemoryId(request.memory_id) });
      return { memory: memoryRow(row) };
    }
    case 'memory_show': {
      const rows = await db.reads.all(issueQueries.memoryShow, { project: operation.project, id: operation.id });
      return { memory: rows[0] ? memoryRow(rows[0]) : missing(operation.project, operation.id) };
    }
    case 'memory_list': case 'memory_search': case 'memory_context': {
      if (operation.op === 'memory_context' && !store) throw new PolylinedbError('invalid_input', 'Memory context requires the selected store identity', 400);
      if (operation.op === 'memory_context' && operation.with_revision && store) {
        const result = await db.batch([
          { sql: statements.memoryRevision.replace(':project', '?'), params: [operation.project] },
          { sql: 'SELECT * FROM memories WHERE project = ? AND sort_key > ? ORDER BY sort_key LIMIT ?', params: [operation.project, operation.after ? memorySortKey(operation.after) : '', operation.limit + 1] },
        ]);
        const revision = revisionToken(result[0]?.rows, operation.project, store);
        return contextPage(operation, (result[1]?.rows ?? []).map(memoryRow), store, revision);
      }
      const rows = (await db.reads.all(issueQueries.memoryList, { project: operation.project, after: operation.after ? memorySortKey(operation.after) : '', limit: operation.limit + 1, query: operation.op === 'memory_search' ? operation.query : null })).map(memoryRow);
      if (operation.op === 'memory_context' && store) return contextPage(operation, rows, store);
      const memories = rows.slice(0, operation.limit);
      return { memories, next_cursor: rows.length > operation.limit ? memories.at(-1)?.id ?? null : null };
    }
    case 'memory_update': case 'memory_delete': {
      const statement: SqlStatement = operation.op === 'memory_update'
        ? { sql: 'UPDATE memories SET title = ?, body = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE project = ? AND id = ? AND version = ? AND version < 9007199254740991 RETURNING *', params: [operation.title, operation.body, new Date().toISOString(), actor, operation.project, operation.id, operation.expected] }
        : { sql: 'DELETE FROM memories WHERE project = ? AND id = ? AND version = ? RETURNING *', params: [operation.project, operation.id, operation.expected] };
      const result = await db.batch([statement, observation(operation.project, operation.id)]).catch(memoryWriteFailure);
      const changed = result[0]?.rows[0];
      if (changed) {
        const memory = memoryRow(changed);
        return operation.op === 'memory_update' ? { memory } : { deleted: { id: memory.id, project: memory.project, version: memory.version } };
      }
      const row = result[1]?.rows[0];
      if (!row) return missing(operation.project, operation.id);
      const memory = memoryRow(row);
      if (memory.version !== operation.expected) throw new PolylinedbError('memory_conflict', 'Memory changed; read it again before editing', 409, { memory, expected: operation.expected });
      if (operation.op === 'memory_update' && memory.version === Number.MAX_SAFE_INTEGER) throw new PolylinedbError('memory_version_exhausted', 'Memory version reached its limit', 409, { memory });
      throw new PolylinedbError('storage_error', 'The database rejected a memory write without a matching condition', 503);
    }
  }
}

function decodeRevision(value: string): RevisionObservation {
  try {
    if (!/^pm1\.(?:[a-f0-9]{2}){1,2048}$/.test(value)) return invalid('Invalid observed memory revision');
    const bytes = Uint8Array.from(value.slice(4).match(/../g) ?? [], hex => Number.parseInt(hex, 16));
    const row: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!row || typeof row !== 'object' || Array.isArray(row) || !('store' in row) || !('incarnation' in row) || !('project' in row) || !('revision' in row) || Object.keys(row).length !== 4) return invalid('Invalid observed memory revision');
    const store = row.store;
    if (!store || typeof store !== 'object' || Array.isArray(store) || !('kind' in store) || Object.keys(store).length !== 2) return invalid('Invalid observed memory store');
    let identity: MemoryStore;
    if (store.kind === 'local' && 'database_path' in store) identity = { kind: 'local', database_path: text(store.database_path, 'database path', 2048) };
    else if (store.kind === 'cloud' && 'url' in store) identity = { kind: 'cloud', url: text(store.url, 'cloud origin', 2048) };
    else return invalid('Invalid observed memory store');
    if (typeof row.incarnation !== 'string' || !/^[a-f0-9]{32}$/.test(row.incarnation)) return invalid('Invalid observed memory incarnation');
    return { store: identity, incarnation: row.incarnation, project: name(row.project, 'project'), revision: integer(row.revision, 'revision', 0) };
  } catch { return invalid('Invalid observed memory revision'); }
}
export function parseMemoryRevision(value: unknown): MemoryRevision {
  if (typeof value !== 'string') return invalid('Observed memory revision must be a token');
  decodeRevision(value);
  return value as MemoryRevision;
}
function revisionToken(rows: readonly Record<string, unknown>[] | undefined, project: string, store: MemoryStore): MemoryRevision {
  const row = rows?.[0];
  if (rows?.length !== 1 || !row || typeof row.incarnation !== 'string' || !/^[a-f0-9]{32}$/.test(row.incarnation) || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 0) throw new PolylinedbError('invalid_store', 'Invalid project memory revision', 500);
  const payload: RevisionObservation = { store, incarnation: row.incarnation, project, revision: row.revision };
  return parseMemoryRevision('pm1.' + Array.from(new TextEncoder().encode(JSON.stringify(payload)), byte => byte.toString(16).padStart(2, '0')).join(''));
}
export function observedMemoryProject(revision: MemoryRevision): string { return decodeRevision(revision).project; }
export async function memoryFreshness(db: SqlExecutor, observed: MemoryRevision, project: string, store: MemoryStore): Promise<MemoryFreshness> {
  const before = decodeRevision(observed);
  if (before.project !== project) return { status: 'stale', project, reason: 'project_changed' };
  if (JSON.stringify(before.store) !== JSON.stringify(store)) return { status: 'stale', project, reason: 'store_changed' };
  const rows = await db.reads.all(issueQueries.memoryRevision, { project });
  const current = decodeRevision(revisionToken(rows, project, store));
  if (current.incarnation !== before.incarnation) return { status: 'stale', project, reason: 'store_changed' };
  return current.revision === before.revision ? { status: 'current', project } : { status: 'stale', project, reason: 'memory_changed' };
}
