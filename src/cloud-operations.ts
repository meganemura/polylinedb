// Owns one authenticated operation request and its response boundary. Login and retries belong to callers.
import { PolylinedbError, issueRow, commentRow, type Operation, type OperationResult, type Issue } from './issues.ts';
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
function result(operation: Operation, value: unknown): OperationResult {
  switch (operation.op) {
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
function errorDetails(code: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  switch (code) {
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
      try { details = errorDetails(error.code, error.details); } catch { return invalid(); }
      throw new PolylinedbError(error.code, 'The cloud rejected the operation.', response.status, details);
    }
    try { return result(input.operation, value); } catch { return invalid(); }
  } catch (error) {
    if (error instanceof PolylinedbError) {
      if (input.operation.op === 'create' && error.status >= 500) error.details = { request_id: input.operation.request_id };
      throw error;
    }
    const details = input.operation.op === 'create' ? { request_id: input.operation.request_id } : undefined;
    throw new PolylinedbError('cloud_unavailable', 'The cloud operation did not return a valid result. Its outcome may be unknown.', 503, details);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}
