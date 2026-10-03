// Owns one authenticated operation request and its response boundary. Login and retries belong to callers.
import { PolylinedbError, issueRow, commentRow, type Issue } from './issues.ts';
import type { Operation, OperationResult } from './operations.ts';
import { memoryRow, parseMemoryId } from './memories.ts';
import type { Memory, MemoryContext } from './memories.ts';
import { fields } from './schema.ts';
import { parseIssueId } from './issue-id.ts';

const responseLimit = 8 * 1024 * 1024;
const timeoutMs = 30_000;
const invalid = (): never => { throw new PolylinedbError('cloud_invalid_response', 'The cloud returned an invalid operation response.', 502); };
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = object(value);
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) return invalid();
  return result;
}
function issue(value: unknown): Issue {
  const row = exact(value, ['id', ...fields, 'versions', 'created_at', 'created_by', 'updated_at', 'updated_by']);
  const versions = exact(row.versions, fields);
  const parsed = issueRow({ ...row, labels_json: JSON.stringify(row.labels), ...Object.fromEntries(fields.map(field => [`${field}_v`, versions[field]])) });
  if (JSON.stringify(parsed.labels) !== JSON.stringify(row.labels)) return invalid();
  return parsed;
}
function memory(value: unknown): Memory {
  return memoryRow(exact(value, ['id', 'project', 'title', 'body', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by']));
}
function result(operation: Operation, value: unknown): OperationResult {
  switch (operation.op) {
    case 'memory_create': case 'memory_show': case 'memory_update': {
      const parsed = memory(exact(value, ['memory']).memory);
      if (parsed.project !== operation.project || ('id' in operation && parsed.id !== operation.id)) return invalid();
      return { memory: parsed };
    }
    case 'memory_delete': {
      const deleted = exact(exact(value, ['deleted']).deleted, ['id', 'project', 'version']);
      if (deleted.id !== operation.id || deleted.project !== operation.project || deleted.version !== operation.expected) return invalid();
      return { deleted: { id: operation.id, project: operation.project, version: operation.expected } };
    }
    case 'memory_list': case 'memory_search': {
      const row = exact(value, ['memories', 'next_cursor']);
      if (!Array.isArray(row.memories) || row.memories.length > operation.limit) return invalid();
      const memories = row.memories.map(memory);
      if (memories.some(entry => entry.project !== operation.project)) return invalid();
      return { memories, next_cursor: row.next_cursor === null ? null : parseMemoryId(row.next_cursor) };
    }
    case 'memory_context': {
      const row = exact(value, ['project', 'store', 'memories', 'limits', 'omitted', 'next_cursor', 'notices']);
      const store = exact(row.store, ['kind', 'url']);
      const limits = exact(row.limits, ['entries', 'bytes']);
      if (row.project !== operation.project || store.kind !== 'cloud' || typeof store.url !== 'string' || limits.entries !== operation.limit || limits.bytes !== operation.max_bytes
        || typeof row.omitted !== 'boolean' || !Array.isArray(row.memories) || row.memories.length > operation.limit || !Array.isArray(row.notices) || row.notices.length > 1
        || new TextEncoder().encode(JSON.stringify(value)).length > operation.max_bytes) return invalid();
      const memories = row.memories.map(memory);
      if (memories.some(entry => entry.project !== operation.project)) return invalid();
      const notices: MemoryContext['notices'] = row.notices.map(value => {
        const notice = object(value);
        exact(notice, Object.hasOwn(notice, 'skipped_id') ? ['code', 'skipped_id'] : ['code']);
        if (notice.code !== 'entry_limit' && notice.code !== 'byte_limit') return invalid();
        return { code: notice.code, ...(notice.skipped_id === undefined ? {} : { skipped_id: parseMemoryId(notice.skipped_id) }) };
      });
      if (row.omitted !== (notices.length > 0)) return invalid();
      return { project: operation.project, store: { kind: 'cloud', url: store.url }, memories, limits: { entries: operation.limit, bytes: operation.max_bytes }, omitted: row.omitted,
        next_cursor: row.next_cursor === null ? null : parseMemoryId(row.next_cursor), notices };
    }
    case 'actor': {
      const row = exact(value, ['actor']);
      if (typeof row.actor !== 'string' || !row.actor.trim() || row.actor.length > 4096 || /\p{Cc}/u.test(row.actor)) return invalid();
      return { actor: row.actor };
    }
    case 'show': {
      const row = exact(value, ['issue', 'comments']);
      if (!Array.isArray(row.comments)) return invalid();
      return { issue: issue(row.issue), comments: row.comments.map(entry => commentRow(exact(entry, ['id', 'issue_id', 'body', 'created_at', 'created_by']))) };
    }
    case 'list': case 'search': {
      const row = exact(value, ['issues', 'next_cursor']);
      if (!Array.isArray(row.issues)) return invalid();
      return { issues: row.issues.map(issue), next_cursor: row.next_cursor === null ? null : parseIssueId(row.next_cursor) };
    }
    case 'comment': return { comment: commentRow(exact(exact(value, ['comment']).comment, ['id', 'issue_id', 'body', 'created_at', 'created_by'])) };
    case 'create': case 'update': case 'close': case 'reopen': return { issue: issue(exact(value, ['issue']).issue) };
    default: { const exhaustive: never = operation; return exhaustive; }
  }
}
function errorDetails(operation: Operation, code: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  switch (code) {
    case 'memory_not_found': case 'memory_deleted': {
      const row = exact(value, ['id', 'project']);
      if (!operation.op.startsWith('memory_') || !('project' in operation) || row.project !== operation.project
        || ('id' in operation && row.id !== operation.id)) return invalid();
      return { id: parseMemoryId(row.id), project: row.project };
    }
    case 'memory_conflict': {
      const row = exact(value, ['memory', 'expected']);
      const current = memory(row.memory);
      if ((operation.op !== 'memory_update' && operation.op !== 'memory_delete') || row.expected !== operation.expected
        || current.project !== operation.project || current.id !== operation.id || current.version === operation.expected) return invalid();
      return { memory: current, expected: row.expected };
    }
    case 'memory_version_exhausted': {
      const current = memory(exact(value, ['memory']).memory);
      if (operation.op !== 'memory_update' || current.project !== operation.project || current.id !== operation.id
        || current.version !== Number.MAX_SAFE_INTEGER || current.version !== operation.expected) return invalid();
      return { memory: current };
    }
    case 'not_found': return { id: parseIssueId(exact(value, ['id']).id) };
    case 'epic_has_children': return { issue: issue(exact(value, ['issue']).issue) };
    case 'version_exhausted': {
      const row = exact(value, ['issue', 'field']);
      if (!fields.some(field => field === row.field)) return invalid();
      return { issue: issue(row.issue), field: row.field };
    }
    case 'conflict': {
      const row = exact(value, ['issue', 'fields']);
      const currentIssue = issue(row.issue);
      if (!Array.isArray(row.fields) || row.fields.length > fields.length) return invalid();
      return { issue: currentIssue, fields: row.fields.map(entry => {
        const conflict = exact(entry, ['field', 'expected', 'actual', 'current']);
        const field = fields.find(field => field === conflict.field);
        if (field === undefined || !Number.isSafeInteger(conflict.expected) || Number(conflict.expected) < 1
          || conflict.actual !== currentIssue.versions[field] || JSON.stringify(conflict.current) !== JSON.stringify(currentIssue[field])) return invalid();
        return { field, expected: conflict.expected, actual: conflict.actual, current: currentIssue[field] };
      }) };
    }
    default: return invalid();
  }
}
async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid();
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > responseLimit)) return invalid();
  if (!response.body) return invalid();
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > responseLimit) { void reader.cancel().catch(() => {}); return invalid(); }
      chunks.push(value);
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  signal.throwIfAborted();
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export async function executeCloudOperation(input: {
  origin: string; operation: Operation; authorize: () => Promise<string>; fetch?: typeof fetch;
}): Promise<OperationResult> {
  let origin: URL;
  try { origin = new URL(input.origin); } catch { throw new PolylinedbError('invalid_configuration', 'Cloud origin must be an HTTPS origin.'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new PolylinedbError('invalid_configuration', 'Cloud origin must be an HTTPS origin.');
  }
  const token = await input.authorize();
  if (!token || /[\r\n]/.test(token)) throw new PolylinedbError('auth_required', 'Run auth login for this cloud connection.', 401);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | undefined;
  try {
    response = await (input.fetch ?? globalThis.fetch)(new URL('/v1/operations', origin), {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input.operation),
    });
    if (response.status === 401) throw new PolylinedbError('auth_required', 'Run auth login for this cloud connection.', 401);
    if (response.status === 403) throw new PolylinedbError('denied', 'Cloud access was denied.', 403);
    let value: unknown;
    try { value = await readResponse(response, controller.signal); } catch { controller.signal.throwIfAborted(); return invalid(); }
    if (response.status !== 200) {
      if (![400, 404, 409].includes(response.status)) return invalid();
      const error = object(exact(value, ['error']).error);
      if (Object.keys(error).some(key => !['code', 'message', 'details'].includes(key)) || typeof error.code !== 'string'
        || !/^[a-z][a-z0-9_]{0,63}$/.test(error.code) || typeof error.message !== 'string' || error.message.length > 4096) return invalid();
      let details: unknown;
      try { details = errorDetails(input.operation, error.code, error.details); } catch { return invalid(); }
      throw new PolylinedbError(error.code, 'The cloud rejected the operation.', response.status, details);
    }
    try {
      const parsed = result(input.operation, value);
      if ('store' in parsed && (parsed.store.kind !== 'cloud' || parsed.store.url !== origin.origin)) return invalid();
      return parsed;
    } catch { return invalid(); }
  } catch (error) {
    if (error instanceof PolylinedbError) {
      if ((input.operation.op === 'create' || input.operation.op === 'memory_create') && error.status >= 500) error.details = { request_id: input.operation.request_id };
      throw error;
    }
    const details = input.operation.op === 'create' || input.operation.op === 'memory_create' ? { request_id: input.operation.request_id } : undefined;
    throw new PolylinedbError('cloud_unavailable', 'The cloud operation did not return a valid result. Its outcome may be unknown.', 503, details);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}
