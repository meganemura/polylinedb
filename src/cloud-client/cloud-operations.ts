// Owns one authenticated operation request and its response boundary. Login and retries belong to callers.
// Two older-Worker answers are the exceptions: a show without `claim` completes with one claim_show request,
// and a search rejected for `with_matches` runs once more without that field.
import { PolylinedbError, type Issue, type SearchMatch } from '../records/index.ts';
import { issueRow, commentRow, issueSortKey } from '../records/persistence.ts';
import type { Operation, OperationResult } from '../records/index.ts';
import { memoryRow } from '../records/persistence.ts';
import { parseMemoryId, parseMemoryRevision, observedMemoryProject } from '../records/index.ts';
import type { Memory, MemoryContext } from '../records/index.ts';
import { fields } from '../records/persistence.ts';
import { parseIssueId, parseRequestId } from '../records/index.ts';
import { statuses } from '../records/persistence.ts';
import { claimRow } from '../records/persistence.ts';
import { parseIncarnation } from '../records/index.ts';
import type { Claim, ClaimInspection } from '../records/index.ts';

const responseLimit = 8 * 1024 * 1024;
const timeoutMs = 30_000;
const invalid = (): never => { throw new PolylinedbError('cloud_invalid_response', 'The cloud returned an invalid operation response.', 502); };
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
// A Worker may add response fields before every client knows them, so each decoder names the keys it reads and drops the rest.
// Required keys, their types, discriminators, and ID echoes stay strict: a Worker must not remove, rename, or retype them.
function known(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const row = object(value);
  if (required.some(key => !Object.hasOwn(row, key))) return invalid();
  return Object.fromEntries([...required, ...optional].filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
}
function issue(value: unknown): Issue {
  const row = known(value, ['id', ...fields, 'versions', 'created_at', 'created_by', 'updated_at', 'updated_by']);
  const versions = known(row.versions, fields);
  const parsed = issueRow({ ...row, labels_json: JSON.stringify(row.labels), ...Object.fromEntries(fields.map(field => [`${field}_v`, versions[field]])) });
  if (JSON.stringify(parsed.labels) !== JSON.stringify(row.labels)) return invalid();
  return parsed;
}
function memory(value: unknown): Memory {
  return memoryRow(known(value, ['id', 'project', 'title', 'body', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by']));
}
function searchMatch(value: unknown, issues: readonly Issue[]): SearchMatch {
  const row = object(value);
  const located = known(row, row.location === 'comment' ? ['issue_id', 'location', 'comment_id', 'excerpt'] : ['issue_id', 'location', 'excerpt']);
  const issue_id = parseIssueId(located.issue_id);
  if (!issues.some(issue => issue.id === issue_id) || typeof located.excerpt !== 'string' || /\p{Cc}/u.test(located.excerpt)) return invalid();
  if (located.location === 'comment') return { issue_id, location: 'comment', comment_id: parseRequestId(located.comment_id), excerpt: located.excerpt };
  if (located.location !== 'body') return invalid();
  return { issue_id, location: 'body', excerpt: located.excerpt };
}
const claimKeys = ['issue_id', 'incarnation', 'session_id', 'generation', 'actor', 'agent_label', 'revision', 'acquired_at', 'changed_at', 'expires_at', 'released_at'];
function claim(value: unknown): Claim { return claimRow(known(value, claimKeys)); }
function claimInspection(value: unknown): ClaimInspection {
  const row = known(value, ['issue_id', 'store_incarnation', 'observed_at', 'state', 'lease']);
  const issue_id = parseIssueId(row.issue_id); const store_incarnation = parseIncarnation(row.store_incarnation);
  if (typeof row.observed_at !== 'number' || !Number.isSafeInteger(row.observed_at) || row.observed_at < 0) return invalid();
  const lease = row.lease === null ? null : claim(row.lease);
  if (lease && lease.issue_id !== issue_id) return invalid();
  const state = lease === null ? 'never_claimed' : lease.incarnation !== store_incarnation ? 'invalidated' : lease.released_at !== null ? 'released' : lease.expires_at <= row.observed_at ? 'expired' : 'active';
  if (row.state !== state) return invalid();
  return { issue_id, store_incarnation, observed_at: row.observed_at, state, lease };
}
// A Worker that reports blockers on acquisition sends sorted open blocker IDs; the result type does not carry them yet.
function openBlockers(value: unknown, dependent: string): boolean {
  if (!Array.isArray(value)) return false;
  let previous = '';
  for (const id of value.map(id => parseIssueId(id))) { const sort = issueSortKey(id); if (id === dependent || sort <= previous) return false; previous = sort; }
  return true;
}
function result(operation: Operation, value: unknown): OperationResult {
  if ('observed_memory_revision' in operation && operation.observed_memory_revision !== undefined) {
    const row = object(value);
    const { memory_freshness, ...base } = row;
    const output = basicResult(operation, base);
    const freshness = known(memory_freshness, ['status', 'project'], ['reason']);
    if (typeof freshness.project !== 'string' || !freshness.project.trim() || new TextEncoder().encode(freshness.project).length > 256 || /\p{Cc}/u.test(freshness.project)) return invalid();
    const expectedProject = 'issue' in output ? output.issue.project : ('project' in operation ? operation.project : undefined) ?? observedMemoryProject(operation.observed_memory_revision);
    if (operation.op !== 'comment' && freshness.project !== expectedProject) return invalid();
    const observedProject = observedMemoryProject(operation.observed_memory_revision);
    if (freshness.status === 'current' && freshness.project !== observedProject) return invalid();
    if (freshness.status === 'stale' && (freshness.reason === 'project_changed') !== (freshness.project !== observedProject)) return invalid();
    if (freshness.status === 'current' || freshness.status === 'unavailable') return { ...output, memory_freshness: { status: freshness.status, project: freshness.project } };
    if (freshness.status === 'stale' && (freshness.reason === 'memory_changed' || freshness.reason === 'project_changed' || freshness.reason === 'store_changed')) return { ...output, memory_freshness: { status: 'stale', project: freshness.project, reason: freshness.reason } };
    return invalid();
  }
  return basicResult(operation, value);
}
function basicResult(operation: Operation, value: unknown): OperationResult {
  switch (operation.op) {
    case 'claim_show': {
      const current = claimInspection(known(value, ['claim']).claim);
      if (current.issue_id !== operation.issue_id) return invalid();
      return { claim: current };
    }
    case 'claim_list': {
      const row = known(value, ['claims', 'next_cursor']);
      if (!Array.isArray(row.claims) || row.claims.length > operation.limit) return invalid();
      const claims = row.claims.map(claimInspection);
      let previous = operation.after === undefined ? '' : issueSortKey(operation.after);
      for (const current of claims) { const sort = issueSortKey(current.issue_id); if (sort <= previous) return invalid(); previous = sort; }
      const next_cursor = row.next_cursor === null ? null : parseIssueId(row.next_cursor);
      if (next_cursor !== null && (claims.length !== operation.limit || next_cursor !== claims.at(-1)?.issue_id)) return invalid();
      return { claims, next_cursor };
    }
    case 'claim_acquire': case 'claim_renew': case 'claim_release': {
      const response = known(value, ['claim_receipt'], operation.op === 'claim_acquire' ? ['open_blockers'] : []);
      if (operation.op === 'claim_acquire' && Object.hasOwn(response, 'open_blockers') && !openBlockers(response.open_blockers, operation.issue_id)) return invalid();
      const row = known(response.claim_receipt, [...claimKeys, 'outcome']);
      const { outcome, ...owner } = row; const parsed = claim(owner);
      const expected = operation.op === 'claim_acquire' ? 'acquired' : operation.op === 'claim_renew' ? 'renewed' : 'released';
      if (outcome !== expected || (outcome === 'released') !== (parsed.released_at !== null)) return invalid();
      if (operation.op === 'claim_acquire') {
        if (parsed.issue_id !== operation.issue_id || parsed.incarnation !== operation.incarnation || parsed.session_id !== operation.session_id || parsed.agent_label !== operation.agent_label || parsed.expires_at !== parsed.changed_at + operation.ttl || parsed.acquired_at !== parsed.changed_at) return invalid();
      } else {
        const proof = operation.claim_proof;
        if (parsed.issue_id !== proof.issue_id || parsed.incarnation !== proof.incarnation || parsed.session_id !== proof.session_id || parsed.generation !== proof.generation || parsed.revision !== operation.expected_revision + 1 || (operation.op === 'claim_renew' && parsed.expires_at !== parsed.changed_at + operation.ttl)) return invalid();
      }
      if (expected === 'released' && parsed.released_at !== null) return { claim_receipt: { ...parsed, outcome: expected, released_at: parsed.released_at } };
      if (expected !== 'released' && parsed.released_at === null) return { claim_receipt: { ...parsed, outcome: expected, released_at: null } };
      return invalid();
    }
    case 'dependency_add': case 'dependency_remove': {
      const row = known(known(value, ['dependency']).dependency, ['dependent_id', 'blocker_id', 'revision', 'outcome']);
      if (row.dependent_id !== operation.dependent_id || row.blocker_id !== operation.blocker_id || row.revision !== operation.expected_revision + 1) return invalid();
      if (operation.op === 'dependency_add' && row.outcome !== 'added' && row.outcome !== 'already_present') return invalid();
      if (operation.op === 'dependency_remove' && row.outcome !== 'removed' && row.outcome !== 'already_absent') return invalid();
      if (row.outcome !== 'added' && row.outcome !== 'already_present' && row.outcome !== 'removed' && row.outcome !== 'already_absent') return invalid();
      return { dependency: { dependent_id: operation.dependent_id, blocker_id: operation.blocker_id, revision: operation.expected_revision + 1, outcome: row.outcome } };
    }
    case 'dependency_list': {
      const row = known(value, ['dependent_id', 'revision', 'blockers', 'next_cursor']);
      if (row.dependent_id !== operation.dependent_id || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1 || !Array.isArray(row.blockers) || row.blockers.length > operation.limit) return invalid();
      const blockers = row.blockers.map(value => {
        const blocker = known(value, ['id', 'project', 'status']);
        if (typeof blocker.project !== 'string' || !blocker.project.trim() || /\p{Cc}/u.test(blocker.project) || new TextEncoder().encode(blocker.project).length > 256) return invalid();
        const status = statuses.find(status => status === blocker.status);
        if (status === undefined) return invalid();
        return { id: parseIssueId(blocker.id), project: blocker.project, status };
      });
      let previous = operation.after === undefined ? '' : issueSortKey(operation.after);
      for (const blocker of blockers) { const sort = issueSortKey(blocker.id); if (sort <= previous) return invalid(); previous = sort; }
      const next_cursor = row.next_cursor === null ? null : parseIssueId(row.next_cursor);
      if (next_cursor !== null && (blockers.length !== operation.limit || next_cursor !== blockers.at(-1)?.id)) return invalid();
      return { dependent_id: operation.dependent_id, revision: row.revision, blockers, next_cursor };
    }
    case 'memory_create': case 'memory_show': case 'memory_update': {
      const parsed = memory(known(value, ['memory']).memory);
      if (parsed.project !== operation.project || ('id' in operation && parsed.id !== operation.id)) return invalid();
      return { memory: parsed };
    }
    case 'memory_delete': {
      const deleted = known(known(value, ['deleted']).deleted, ['id', 'project', 'version']);
      if (deleted.id !== operation.id || deleted.project !== operation.project || deleted.version !== operation.expected) return invalid();
      return { deleted: { id: operation.id, project: operation.project, version: operation.expected } };
    }
    case 'memory_list': case 'memory_search': {
      const row = known(value, ['memories', 'next_cursor']);
      if (!Array.isArray(row.memories) || row.memories.length > operation.limit) return invalid();
      const memories = row.memories.map(memory);
      if (memories.some(entry => entry.project !== operation.project)) return invalid();
      return { memories, next_cursor: row.next_cursor === null ? null : parseMemoryId(row.next_cursor) };
    }
    case 'memory_context': {
      const row = known(value, ['project', 'store', 'memories', 'limits', 'omitted', 'next_cursor', 'notices', ...(operation.with_revision ? ['memory_revision'] : [])]);
      const store = known(row.store, ['kind', 'url']);
      const limits = known(row.limits, ['entries', 'bytes']);
      if (row.project !== operation.project || store.kind !== 'cloud' || typeof store.url !== 'string' || limits.entries !== operation.limit || limits.bytes !== operation.max_bytes
        || typeof row.omitted !== 'boolean' || !Array.isArray(row.memories) || row.memories.length > operation.limit || !Array.isArray(row.notices) || row.notices.length > 1
        || new TextEncoder().encode(JSON.stringify(value)).length > operation.max_bytes) return invalid();
      const memories = row.memories.map(memory);
      if (memories.some(entry => entry.project !== operation.project)) return invalid();
      const notices: MemoryContext['notices'] = row.notices.map(value => {
        const notice = known(value, ['code'], ['skipped_id']);
        if (notice.code !== 'entry_limit' && notice.code !== 'byte_limit') return invalid();
        return { code: notice.code, ...(notice.skipped_id === undefined ? {} : { skipped_id: parseMemoryId(notice.skipped_id) }) };
      });
      if (row.omitted !== (notices.length > 0)) return invalid();
      let revision;
      if (operation.with_revision) {
        try { revision = parseMemoryRevision(row.memory_revision); } catch { return invalid(); }
        if (observedMemoryProject(revision) !== operation.project) return invalid();
      }
      return { project: operation.project, store: { kind: 'cloud', url: store.url }, memories, limits: { entries: operation.limit, bytes: operation.max_bytes }, omitted: row.omitted,
        next_cursor: row.next_cursor === null ? null : parseMemoryId(row.next_cursor), notices, ...(revision === undefined ? {} : { memory_revision: revision }) };
    }
    case 'actor': {
      const row = known(value, ['actor']);
      if (typeof row.actor !== 'string' || !row.actor.trim() || row.actor.length > 4096 || /\p{Cc}/u.test(row.actor)) return invalid();
      return { actor: row.actor };
    }
    case 'show': {
      const row = known(value, ['issue', 'comments', 'claim']);
      if (!Array.isArray(row.comments)) return invalid();
      const shown = issue(row.issue); const current = claimInspection(row.claim);
      if (current.issue_id !== shown.id) return invalid();
      return { issue: shown, comments: row.comments.map(entry => commentRow(known(entry, ['id', 'issue_id', 'body', 'created_at', 'created_by']))), claim: current };
    }
    case 'list': case 'search': case 'dependency_worklist': {
      const withMatches = operation.op === 'search' && operation.with_matches === true;
      const row = known(value, withMatches ? ['issues', 'next_cursor', 'matches'] : ['issues', 'next_cursor']);
      if (!Array.isArray(row.issues)) return invalid();
      const issues = row.issues.map(issue); const next_cursor = row.next_cursor === null ? null : parseIssueId(row.next_cursor);
      if (operation.op === 'dependency_worklist') {
        if (issues.length > operation.limit) return invalid();
        let previous = operation.after === undefined ? '' : issueSortKey(operation.after);
        for (const current of issues) {
          const sort = issueSortKey(current.id);
          if (sort <= previous || (operation.state === 'ready' ? current.status !== 'open' : current.status === 'closed') || (operation.tool !== undefined && current.tool !== operation.tool) || (operation.project !== undefined && current.project !== operation.project) || (operation.type !== undefined && current.type !== operation.type) || (operation.priority !== undefined && current.priority !== operation.priority) || (operation.label !== undefined && !current.labels.includes(operation.label))) return invalid();
          previous = sort;
        }
        if (next_cursor !== null && (issues.length !== operation.limit || next_cursor !== issues.at(-1)?.id)) return invalid();
      }
      if (withMatches) {
        if (!Array.isArray(row.matches)) return invalid();
        return { issues, next_cursor, matches: row.matches.map(match => searchMatch(match, issues)) };
      }
      return { issues, next_cursor };
    }
    case 'comment': return { comment: commentRow(known(known(value, ['comment']).comment, ['id', 'issue_id', 'body', 'created_at', 'created_by'])) };
    case 'create': case 'update': case 'close': case 'reopen': return { issue: issue(known(value, ['issue']).issue) };
    default: { const exhaustive: never = operation; return exhaustive; }
  }
}
function errorDetails(operation: Operation, code: string, value: unknown): unknown {
  if (value === undefined) return undefined;
  switch (code) {
    case 'claim_conflict': {
      if (operation.op !== 'claim_acquire' && operation.op !== 'claim_renew' && operation.op !== 'claim_release') return invalid();
      const current = claimInspection(known(value, ['current']).current);
      if (current.issue_id !== (operation.op === 'claim_acquire' ? operation.issue_id : operation.claim_proof.issue_id)) return invalid();
      return { current };
    }
    case 'claim_required': {
      // The agent gate names only the issue; a missing ownership proof returns the current issue.
      if (object(value).id !== undefined) {
        const target = operation.op === 'dependency_add' || operation.op === 'dependency_remove' ? operation.dependent_id
          : operation.op === 'update' || operation.op === 'close' || operation.op === 'reopen' || operation.op === 'comment' ? operation.id : invalid();
        if (known(value, ['id']).id !== target) return invalid();
        return { id: target };
      }
      if (operation.op !== 'update' && operation.op !== 'close' && operation.op !== 'reopen') return invalid();
      const current = issue(known(value, ['issue']).issue); if (current.id !== operation.id) return invalid();
      return { issue: current };
    }
    case 'not_ready': {
      if (operation.op !== 'claim_acquire' || known(value, ['id']).id !== operation.issue_id) return invalid();
      return { id: operation.issue_id };
    }
    case 'dependency_conflict': {
      if (operation.op !== 'dependency_add' && operation.op !== 'dependency_remove') return invalid();
      const row = known(value, ['expected_revision', 'current']);
      if (row.expected_revision !== operation.expected_revision) return invalid();
      const current = basicResult({ op: 'dependency_list', dependent_id: operation.dependent_id, limit: 50 }, row.current);
      if (!('revision' in current) || current.revision === operation.expected_revision) return invalid();
      return { expected_revision: operation.expected_revision, current };
    }
    case 'dependency_version_exhausted': {
      const row = known(value, ['dependent_id']);
      if ((operation.op !== 'dependency_add' && operation.op !== 'dependency_remove') || row.dependent_id !== operation.dependent_id || operation.expected_revision !== Number.MAX_SAFE_INTEGER) return invalid();
      return { dependent_id: operation.dependent_id };
    }
    case 'dependency_blocked': return { issue: issue(known(value, ['issue']).issue) };
    case 'memory_not_found': case 'memory_deleted': {
      const row = known(value, ['id', 'project']);
      if (!operation.op.startsWith('memory_') || !('project' in operation) || row.project !== operation.project
        || ('id' in operation && row.id !== operation.id)) return invalid();
      return { id: parseMemoryId(row.id), project: row.project };
    }
    case 'memory_conflict': {
      const row = known(value, ['memory', 'expected']);
      const current = memory(row.memory);
      if ((operation.op !== 'memory_update' && operation.op !== 'memory_delete') || row.expected !== operation.expected
        || current.project !== operation.project || current.id !== operation.id || current.version === operation.expected) return invalid();
      return { memory: current, expected: row.expected };
    }
    case 'memory_version_exhausted': {
      const current = memory(known(value, ['memory']).memory);
      if (operation.op !== 'memory_update' || current.project !== operation.project || current.id !== operation.id
        || current.version !== Number.MAX_SAFE_INTEGER || current.version !== operation.expected) return invalid();
      return { memory: current };
    }
    case 'not_found': return { id: parseIssueId(known(value, ['id']).id) };
    case 'epic_has_children': return { issue: issue(known(value, ['issue']).issue) };
    case 'version_exhausted': {
      const row = known(value, ['issue', 'field']);
      if (!fields.some(field => field === row.field)) return invalid();
      return { issue: issue(row.issue), field: row.field };
    }
    case 'conflict': {
      const row = known(value, ['issue', 'fields']);
      const currentIssue = issue(row.issue);
      if (!Array.isArray(row.fields) || row.fields.length > fields.length) return invalid();
      return { issue: currentIssue, fields: row.fields.map(entry => {
        const conflict = known(entry, ['field', 'expected', 'actual', 'current']);
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
  let retried = false;
  try {
    response = await (input.fetch ?? globalThis.fetch)(new URL('/v1/operations', origin), {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input.operation),
    });
    if (response.status === 401) throw new PolylinedbError('auth_required', 'Run auth login for this cloud connection.', 401);
    if (response.status === 403) {
      // Access itself answers 403 without this envelope, so only the Worker's read-only rejection keeps its code.
      let readOnly = false;
      try {
        const error = known(known(await readResponse(response, controller.signal), ['error']).error, ['code', 'message', 'details']);
        readOnly = error.code === 'read_only_actor' && known(error.details, ['op']).op === input.operation.op;
      } catch { controller.signal.throwIfAborted(); }
      if (readOnly) throw new PolylinedbError('read_only_actor', 'This cloud actor can only read.', 403, { op: input.operation.op });
      throw new PolylinedbError('denied', 'Cloud access was denied.', 403);
    }
    let value: unknown;
    try { value = await readResponse(response, controller.signal); } catch { controller.signal.throwIfAborted(); return invalid(); }
    if (response.status !== 200) {
      if (response.status === 503) {
        const error = known(known(value, ['error']).error, ['code', 'message']);
        if ((error.code !== 'invalid_access_configuration' && error.code !== 'jwks_unavailable') || typeof error.message !== 'string' || error.message.length > 4096) return invalid();
        const message = error.code === 'invalid_access_configuration'
          ? 'Cloud Access is misconfigured. Check the Worker Access configuration.'
          : 'Cloud signing keys are temporarily unavailable. Retry later with the same request ID when one was returned.';
        throw new PolylinedbError(error.code, message, 503);
      }
      if (![400, 404, 409].includes(response.status)) return invalid();
      const error = known(known(value, ['error']).error, ['code', 'message'], ['details']);
      if (typeof error.code !== 'string'
        || !/^[a-z][a-z0-9_]{0,63}$/.test(error.code) || error.code === 'invalid_access_configuration' || error.code === 'jwks_unavailable' || typeof error.message !== 'string' || error.message.length > 4096) return invalid();
      let details: unknown;
      try { details = errorDetails(input.operation, error.code, error.details); } catch { return invalid(); }
      if (response.status === 400 && error.code === 'invalid_input' && input.operation.op === 'search' && input.operation.with_matches === true && /\bwith_matches\b/.test(error.message)) {
        // A Worker released before search matches names the unknown field only in this message. Its page without matches still answers the search.
        const { with_matches: _, ...plain } = input.operation;
        retried = true;
        return await executeCloudOperation({ ...input, operation: plain });
      }
      throw new PolylinedbError(error.code, 'The cloud rejected the operation.', response.status, details);
    }
    if (input.operation.op === 'show' && !Object.hasOwn(object(value), 'claim')) {
      // A Worker released before show returned `claim` omits it, and claim_show reads the same inspection, so a show result always has one.
      const inspected = await executeCloudOperation({ ...input, operation: { op: 'claim_show', issue_id: input.operation.id } });
      if (!('claim' in inspected)) return invalid();
      value = { ...object(value), claim: inspected.claim };
    }
    try {
      const parsed = result(input.operation, value);
      if ('store' in parsed && (parsed.store.kind !== 'cloud' || parsed.store.url !== origin.origin)) return invalid();
      return parsed;
    } catch { return invalid(); }
  } catch (error) {
    // The retry is a whole request, so its errors reach the caller as a first request's would. An authorization failure keeps its code.
    if (retried) throw error;
    if (error instanceof PolylinedbError) {
      if ((input.operation.op === 'create' || input.operation.op === 'memory_create' || input.operation.op === 'dependency_add' || input.operation.op === 'dependency_remove' || input.operation.op === 'claim_acquire' || input.operation.op === 'claim_renew' || input.operation.op === 'claim_release') && error.status >= 500) error.details = { request_id: input.operation.request_id };
      throw error;
    }
    const details = input.operation.op === 'create' || input.operation.op === 'memory_create' || input.operation.op === 'dependency_add' || input.operation.op === 'dependency_remove' || input.operation.op === 'claim_acquire' || input.operation.op === 'claim_renew' || input.operation.op === 'claim_release' ? { request_id: input.operation.request_id } : undefined;
    throw new PolylinedbError('cloud_unavailable', 'The cloud operation did not return a valid result. Its outcome may be unknown.', 503, details);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
}
