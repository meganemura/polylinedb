// Owns portable snapshot validation and canonical form; storage and file access belong to callers.
import { commentRow, issueRow, parseOperation, PolylinedbError } from "./issues.ts";
import { issueSortKey, parseIssueId, parsePrefix, parseRequestId } from "./issue-id.ts";
import type { Comment, Issue } from "./issues.ts";
import { fields } from "./schema.ts";
import { memoryRow, memorySortKey, parseMemoryId, parseMemoryOperation } from "./memories.ts";
import type { Memory, MemoryCounter, MemoryRequest } from "./memories.ts";

export type Counter = { scope: string; last_number: number };
export type CreateRequest = { request_id: string; actor: string; payload: string; issue_id: string };
type SnapshotV2 = { format: 'polylinedb.snapshot'; version: 2; issues: readonly Issue[]; comments: readonly Comment[];
  counters: readonly Counter[]; requests: readonly CreateRequest[] };
export type Snapshot = Omit<SnapshotV2, 'version'> & { version: 3; memories: readonly Memory[]; memory_counters: readonly MemoryCounter[]; memory_requests: readonly MemoryRequest[] };
export type SnapshotImport = { result: 'imported' | 'already_present'; issues: number; comments: number; memories: number; sha256: string };
const fail = (message: string): never => { throw new PolylinedbError('invalid_snapshot', message, 400); };
function record(value: unknown, expected: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Expected an object');
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== expected.length || expected.some(key => !Object.hasOwn(row, key))) return fail('Unexpected or missing snapshot fields');
  return row;
}
function timestamp(value: unknown): void {
  if (typeof value !== 'string') return fail('Invalid snapshot timestamp');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) fail('Invalid snapshot timestamp');
  const day = value.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) fail('Invalid snapshot timestamp');
}
function parseSnapshotV2(input: unknown): SnapshotV2 {
  const source = record(input, ['format', 'version', 'issues', 'comments', 'counters', 'requests']);
  if (source.format !== 'polylinedb.snapshot' || source.version !== 2) return fail('Unsupported snapshot format or version');
  if (!Array.isArray(source.issues) || !Array.isArray(source.comments) || !Array.isArray(source.counters) || !Array.isArray(source.requests)) return fail('Snapshot collections must be arrays');
  try {
    const issues = source.issues.map(value => {
      const row = record(value, ['id', ...fields, 'versions', 'created_at', 'created_by', 'updated_at', 'updated_by']);
      const versions = record(row.versions, fields);
      timestamp(row.created_at); timestamp(row.updated_at);
      return issueRow({ ...row, labels_json: JSON.stringify(row.labels), ...Object.fromEntries(fields.map(field => [`${field}_v`, versions[field]])) });
    });
    const comments = source.comments.map(value => {
      const row = record(value, ['id', 'issue_id', 'body', 'created_at', 'created_by']);
      timestamp(row.created_at);
      const comment = commentRow(row);
      if (comment.id.includes('.')) fail('Comment IDs must be UUIDs');
      return comment;
    });
    const byId = new Map(issues.map(issue => [issue.id, issue]));
    if (byId.size !== issues.length || new Set(comments.map(comment => comment.id)).size !== comments.length) fail('Duplicate snapshot IDs');
    for (const issue of issues) {
      const split = issue.id.lastIndexOf('.');
      if (split >= 0 && byId.get(issue.id.slice(0, split))?.type !== 'epic') fail('Every parent must exist and be an epic');
    }
    for (const comment of comments) if (!byId.has(comment.issue_id)) fail('Comment issue does not exist');
    const counters = source.counters.map(value => {
      const row = record(value, ['scope', 'last_number']);
      const scope = typeof row.scope === 'string' && row.scope.includes('-') ? parseIssueId(row.scope) : parsePrefix(row.scope);
      if (scope.includes('-') && !byId.has(scope)) fail('Counter parent does not exist');
      if (typeof row.last_number !== 'number' || !Number.isSafeInteger(row.last_number) || row.last_number < 1) return fail('Invalid counter value');
      return { scope, last_number: row.last_number };
    }).sort((a, b) => compareText(a.scope, b.scope));
    const byScope = new Map(counters.map(counter => [counter.scope, counter.last_number]));
    if (byScope.size !== counters.length) fail('Duplicate counter scopes');
    for (const issue of issues) {
      const split = issue.id.lastIndexOf('.');
      const boundary = split < 0 ? issue.id.indexOf('-') : split;
      const scope = issue.id.slice(0, boundary);
      const number = Number(issue.id.slice(boundary + 1));
      if ((byScope.get(scope) ?? 0) < number) fail('Counter is below an issued number');
    }
    const requests = source.requests.map(value => {
      const row = record(value, ['request_id', 'actor', 'payload', 'issue_id']);
      const request_id = parseRequestId(row.request_id);
      const issue_id = parseIssueId(row.issue_id);
      if (!byId.has(issue_id)) fail('Request issue does not exist');
      if (typeof row.actor !== 'string' || !row.actor.trim() || /\p{Cc}/u.test(row.actor) || new TextEncoder().encode(row.actor).length > 256) return fail('Invalid request actor');
      if (byId.get(issue_id)?.created_by !== row.actor) fail('Request actor differs from the issue creator');
      if (typeof row.payload !== 'string') return fail('Invalid request payload');
      const operation = parseOperation(JSON.parse(row.payload));
      if (operation.op !== 'create' || operation.request_id !== request_id || JSON.stringify(operation) !== row.payload) return fail('Request payload must be a canonical create operation');
      const split = issue_id.lastIndexOf('.');
      if (operation.prefix !== issue_id.slice(0, issue_id.indexOf('-')) || (operation.parent ?? null) !== (split < 0 ? null : issue_id.slice(0, split))) fail('Request does not match the issued ID');
      return { request_id, actor: row.actor, payload: row.payload, issue_id };
    }).sort((a, b) => compareText(a.request_id, b.request_id));
    if (new Set(requests.map(request => request.request_id)).size !== requests.length || new Set(requests.map(request => request.issue_id)).size !== requests.length) fail('Duplicate create requests');
    return { format: 'polylinedb.snapshot', version: 2, issues: issues.sort((a, b) => compareText(issueSortKey(a.id), issueSortKey(b.id))), comments: comments.sort(compareId), counters, requests };
  } catch (error) {
    if (error instanceof PolylinedbError && error.code === 'invalid_snapshot') throw error;
    return fail(error instanceof Error ? error.message : 'Invalid snapshot');
  }
}
function compareId(a: { id: string }, b: { id: string }): number { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
export function convertSnapshotV2(input: unknown): Snapshot {
  return { ...parseSnapshotV2(input), version: 3, memories: [], memory_counters: [], memory_requests: [] };
}
export function parseSnapshot(input: unknown): Snapshot {
  const source = record(input, ['format', 'version', 'issues', 'comments', 'counters', 'requests', 'memories', 'memory_counters', 'memory_requests']);
  if (source.version !== 3) return fail('Unsupported snapshot version; convert version 2 explicitly');
  const issueSnapshot = parseSnapshotV2({ format: source.format, version: 2, issues: source.issues, comments: source.comments, counters: source.counters, requests: source.requests });
  if (!Array.isArray(source.memories) || !Array.isArray(source.memory_counters) || !Array.isArray(source.memory_requests)) return fail('Memory snapshot collections must be arrays');
  try {
    const memories = source.memories.map(value => {
      const row = record(value, ['id', 'project', 'title', 'body', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by']);
      timestamp(row.created_at); timestamp(row.updated_at);
      return memoryRow(row);
    }).sort((a, b) => compareText(memorySortKey(a.id), memorySortKey(b.id)));
    const byId = new Map(memories.map(memory => [memory.id, memory]));
    if (byId.size !== memories.length) fail('Duplicate memory IDs');
    const memory_counters = source.memory_counters.map(value => {
      const row = record(value, ['prefix', 'last_number']);
      const prefix = parsePrefix(row.prefix);
      if (typeof row.last_number !== 'number' || !Number.isSafeInteger(row.last_number) || row.last_number < 1) return fail('Invalid memory counter');
      return { prefix, last_number: row.last_number };
    }).sort((a, b) => compareText(a.prefix, b.prefix));
    const byPrefix = new Map(memory_counters.map(counter => [counter.prefix, counter.last_number]));
    if (byPrefix.size !== memory_counters.length) fail('Duplicate memory counter prefixes');
    const checkNumber = (id: string) => {
      const separator = id.indexOf('-m');
      if ((byPrefix.get(id.slice(0, separator)) ?? 0) < Number(id.slice(separator + 2))) fail('Memory counter is below an issued number');
    };
    for (const memory of memories) checkNumber(memory.id);
    const memory_requests = source.memory_requests.map(value => {
      const row = record(value, ['request_id', 'actor', 'payload', 'memory_id']);
      const request_id = parseRequestId(row.request_id);
      const memory_id = parseMemoryId(row.memory_id);
      checkNumber(memory_id);
      if (typeof row.actor !== 'string' || !row.actor.trim() || /\p{Cc}/u.test(row.actor) || new TextEncoder().encode(row.actor).length > 256 || typeof row.payload !== 'string') return fail('Invalid memory request');
      const operation = parseMemoryOperation(JSON.parse(row.payload));
      if (operation.op !== 'memory_create' || operation.request_id !== request_id || JSON.stringify(operation) !== row.payload || !memory_id.startsWith(`${operation.prefix}-m`)) return fail('Invalid canonical memory request');
      const memory = byId.get(memory_id);
      if (memory && (memory.project !== operation.project || memory.created_by !== row.actor)) fail('Memory request differs from its memory');
      return { request_id, actor: row.actor, payload: row.payload, memory_id };
    }).sort((a, b) => compareText(a.request_id, b.request_id));
    if (new Set(memory_requests.map(row => row.request_id)).size !== memory_requests.length || new Set(memory_requests.map(row => row.memory_id)).size !== memory_requests.length) fail('Duplicate memory requests');
    const requestedIds = new Set(memory_requests.map(request => request.memory_id));
    if (memories.some(memory => !requestedIds.has(memory.id))) fail('Every memory must retain its creation request');
    return { ...issueSnapshot, version: 3, memories, memory_counters, memory_requests };
  } catch (error) {
    if (error instanceof PolylinedbError && error.code === 'invalid_snapshot') throw error;
    return fail(error instanceof Error ? error.message : 'Invalid memory snapshot');
  }
}
export function canonicalSnapshot(snapshot: Snapshot): string { return JSON.stringify(parseSnapshot(snapshot)); }
