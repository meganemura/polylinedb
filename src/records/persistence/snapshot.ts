// Owns portable snapshot validation and canonical form; storage and file access belong to callers.
import { commentRow, issueRow, parseClosure, storedCommentRow } from "../store/issue-record.ts";
import { parseOperation } from "../issues/issues.ts";
import { PolylinedbError } from '../store/errors.ts';
import { issueSortKey, parseIssueId, parsePrefix, parseRequestId } from "../store/issue-id.ts";
import type { Comment, CommentEdits, Issue, StoredComment, StoredIssue } from "../store/issue-record.ts";
import { fields } from "../../transition/index.ts";
import { memoryRow, memorySortKey, parseMemoryId, parseMemoryOperation } from "../memories/memories.ts";
import type { Memory, MemoryCounter, MemoryRequest } from "../memories/memories.ts";
import { parseDependencyOperation } from '../dependencies/dependencies.ts';
import type { Dependency, DependencyRevision, DependencyRequest } from '../dependencies/dependencies.ts';
import { claimRow, claimRequestRow, parseClaimOperation } from '../claims/claims.ts';
import type { Claim, ClaimRequest } from '../claims/claims.ts';
import { parseLandOrderOperation } from '../land-order/land-order.ts';
import type { LandOrderEdge, LandOrderRequest, LandOrderRevision } from '../land-order/land-order.ts';
import { parseResourceOperation, resourceEntry } from '../resources/resources.ts';
import type { ResourceEntry, ResourceRequest, ResourceRevision } from '../resources/resources.ts';
import { starRow } from '../posts/posts.ts';
import type { Star } from '../posts/posts.ts';
import { itemRow } from '../store/issue-items.ts';
import type { Item } from '../store/issue-items.ts';

export type Counter = { scope: string; last_number: number };
export type CreateRequest = { request_id: string; actor: string; payload: string; issue_id: string };
type SnapshotV2 = { format: 'polylinedb.snapshot'; version: 2; issues: readonly Issue[]; comments: readonly Comment[];
  counters: readonly Counter[]; requests: readonly CreateRequest[] };
type SnapshotV3 = Omit<SnapshotV2, 'version'> & { version: 3; memories: readonly Memory[]; memory_counters: readonly MemoryCounter[]; memory_requests: readonly MemoryRequest[] };
type SnapshotV4 = Omit<SnapshotV3, 'version'> & { version: 4; dependencies: readonly Dependency[]; dependency_revisions: readonly DependencyRevision[]; dependency_requests: readonly DependencyRequest[] };
type SnapshotV5 = Omit<SnapshotV4, 'version'> & { version: 5; issue_claims: readonly Claim[]; claim_requests: readonly ClaimRequest[] };
type SnapshotV6 = Omit<SnapshotV5, 'version' | 'issues'> & { version: 6; issues: readonly StoredIssue[] };
type SnapshotV7 = Omit<SnapshotV6, 'version'> & { version: 7; land_order: readonly LandOrderEdge[]; land_order_revisions: readonly LandOrderRevision[]; land_order_requests: readonly LandOrderRequest[];
  issue_resources: readonly ResourceEntry[]; resource_revisions: readonly ResourceRevision[]; resource_requests: readonly ResourceRequest[] };
type EditedComment = Pick<StoredComment, 'id' | 'issue_id' | 'body' | 'created_at' | 'created_by'> & CommentEdits;
type SnapshotV8 = Omit<SnapshotV7, 'version' | 'comments'> & { version: 8; comments: readonly EditedComment[] };
type SnapshotV9 = Omit<SnapshotV8, 'version' | 'comments'> & { version: 9; comments: readonly StoredComment[]; stars: readonly Star[] };
/** An item row as stored: the item with its issue and the request ID that added it. */
export type SnapshotItem = Item & { issue_id: string; request_id: string };
export type Snapshot = Omit<SnapshotV9, 'version'> & { version: 10; issue_items: readonly SnapshotItem[] };
export type SnapshotImport = { result: 'imported' | 'already_present'; issues: number; comments: number; memories: number; dependencies: number; dependency_revisions: number; dependency_requests: number; issue_claims: number; claim_requests: number;
  land_order: number; land_order_requests: number; issue_resources: number; resource_requests: number; stars: number; issue_items: number; sha256: string };
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
  return convertSnapshotV3({ ...parseSnapshotV2(input), version: 3, memories: [], memory_counters: [], memory_requests: [] });
}
function parseSnapshotV3(input: unknown): SnapshotV3 {
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
/** Release 0.1.0 restore checkpoints hold the digest of this form, so it must stay byte-identical to that release. */
export function canonicalSnapshotV3(input: unknown): string { return JSON.stringify(parseSnapshotV3(input)); }
export function convertSnapshotV3(input: unknown): Snapshot {
  const snapshot = parseSnapshotV3(input);
  return convertSnapshotV4({ ...snapshot, version: 4, dependencies: [], dependency_revisions: snapshot.issues.map(issue => ({ dependent_id: issue.id, revision: 1 })), dependency_requests: [] });
}
function parseSnapshotV4(input: unknown): SnapshotV4 {
  const source = record(input, ['format', 'version', 'issues', 'comments', 'counters', 'requests', 'memories', 'memory_counters', 'memory_requests', 'dependencies', 'dependency_revisions', 'dependency_requests']);
  if (source.version !== 4) return fail('Unsupported snapshot version; convert versions 2 and 3 explicitly');
  const { dependencies: edges, dependency_revisions: revisions, dependency_requests: requests, ...legacy } = source;
  const old = parseSnapshotV3({ ...legacy, version: 3 });
  if (!Array.isArray(edges) || !Array.isArray(revisions) || !Array.isArray(requests)) return fail('Dependency collections must be arrays');
  try {
    const ids = new Set(old.issues.map(issue => issue.id));
    const endpoint = (value: unknown) => { const id = parseIssueId(value); if (!ids.has(id)) return fail('Dependency endpoint does not exist'); return id; };
    const positive = (value: unknown) => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return fail('Invalid dependency revision'); return value; };
    const dependency_revisions = revisions.map(value => {
      const row = record(value, ['dependent_id', 'revision']);
      return { dependent_id: endpoint(row.dependent_id), revision: positive(row.revision) };
    }).sort((a, b) => compareText(issueSortKey(a.dependent_id), issueSortKey(b.dependent_id)));
    const byId = new Map(dependency_revisions.map(row => [row.dependent_id, row.revision]));
    if (byId.size !== dependency_revisions.length || byId.size !== ids.size) fail('Every issue must have one dependency revision');
    const dependencies = edges.map(value => {
      const row = record(value, ['dependent_id', 'blocker_id']);
      return { dependent_id: endpoint(row.dependent_id), blocker_id: endpoint(row.blocker_id) };
    }).sort((a, b) => compareText(issueSortKey(a.dependent_id), issueSortKey(b.dependent_id)) || compareText(issueSortKey(a.blocker_id), issueSortKey(b.blocker_id)));
    const outgoing = new Map<string, Set<string>>();
    const degree = new Map([...ids].map(id => [id, 0]));
    for (const edge of dependencies) {
      const next = outgoing.get(edge.dependent_id) ?? new Set<string>();
      if (next.has(edge.blocker_id)) fail('Duplicate dependency tuple');
      next.add(edge.blocker_id); outgoing.set(edge.dependent_id, next);
      degree.set(edge.blocker_id, (degree.get(edge.blocker_id) ?? 0) + 1);
    }
    const queue = [...degree].filter(([, count]) => count === 0).map(([id]) => id);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i]; if (id === undefined) continue;
      for (const blocker of outgoing.get(id) ?? []) {
        const count = (degree.get(blocker) ?? 0) - 1; degree.set(blocker, count);
        if (count === 0) queue.push(blocker);
      }
    }
    if (queue.length !== ids.size) fail('Dependency graph contains a cycle');
    const dependency_requests = requests.map((value): DependencyRequest => {
      const row = record(value, ['request_id', 'actor', 'payload', 'dependent_id', 'blocker_id', 'result_revision', 'outcome', 'created_at']);
      const request_id = parseRequestId(row.request_id); const dependent_id = endpoint(row.dependent_id); const blocker_id = endpoint(row.blocker_id);
      const result_revision = positive(row.result_revision);
      if (result_revision < 2 || result_revision > (byId.get(dependent_id) ?? 0)) fail('Dependency receipt exceeds the aggregate revision');
      if (typeof row.actor !== 'string' || !row.actor.trim() || /\p{Cc}/u.test(row.actor) || new TextEncoder().encode(row.actor).length > 256 || typeof row.payload !== 'string') return fail('Invalid dependency receipt actor or payload');
      timestamp(row.created_at); if (typeof row.created_at !== 'string') return fail('Invalid dependency timestamp');
      const operation = parseDependencyOperation(JSON.parse(row.payload));
      if ((operation.op !== 'dependency_add' && operation.op !== 'dependency_remove') || operation.request_id !== request_id || operation.dependent_id !== dependent_id || operation.blocker_id !== blocker_id || operation.expected_revision + 1 !== result_revision || JSON.stringify(operation) !== row.payload) return fail('Invalid canonical dependency receipt');
      const outcome = row.outcome;
      if (outcome !== 'added' && outcome !== 'already_present' && outcome !== 'removed' && outcome !== 'already_absent') return fail('Invalid dependency receipt outcome');
      if ((operation.op === 'dependency_add') !== (outcome === 'added' || outcome === 'already_present')) return fail('Dependency receipt outcome differs from the operation');
      return { request_id, actor: row.actor, payload: row.payload, dependent_id, blocker_id, result_revision, outcome, created_at: row.created_at };
    }).sort((a, b) => compareText(a.request_id, b.request_id));
    if (new Set(dependency_requests.map(row => row.request_id)).size !== dependency_requests.length) fail('Duplicate dependency request ID');
    const results = new Map<string, Set<number>>();
    for (const row of dependency_requests) {
      const seen = results.get(row.dependent_id) ?? new Set<number>();
      if (seen.has(row.result_revision)) fail('Duplicate dependency receipt revision');
      seen.add(row.result_revision); results.set(row.dependent_id, seen);
    }
    return { ...old, version: 4, dependencies, dependency_revisions, dependency_requests };
  } catch (error) {
    if (error instanceof PolylinedbError && error.code === 'invalid_snapshot') throw error;
    return fail(error instanceof Error ? error.message : 'Invalid dependency snapshot');
  }
}
export function convertSnapshotV4(input: unknown): Snapshot {
  return convertSnapshotV5({ ...parseSnapshotV4(input), version: 5, issue_claims: [], claim_requests: [] });
}
const snapshotKeys = ['format', 'version', 'issues', 'comments', 'counters', 'requests', 'memories', 'memory_counters', 'memory_requests', 'dependencies', 'dependency_revisions', 'dependency_requests', 'issue_claims', 'claim_requests'];
function parseSnapshotV5(input: unknown): SnapshotV5 {
  const source = record(input, snapshotKeys);
  if (source.version !== 5) return fail('Unsupported snapshot version; convert versions 2, 3 and 4 explicitly');
  const { issue_claims: claims, claim_requests: requests, ...legacy } = source;
  const old = parseSnapshotV4({ ...legacy, version: 4 });
  if (!Array.isArray(claims) || !Array.isArray(requests)) return fail('Claim collections must be arrays');
  try {
    const ids = new Set(old.issues.map(issue => issue.id));
    const claimKeys = ['issue_id', 'incarnation', 'session_id', 'generation', 'actor', 'agent_label', 'revision', 'acquired_at', 'changed_at', 'expires_at', 'released_at'];
    const issue_claims = claims.map(value => claimRow(record(value, claimKeys))).sort((a, b) => compareText(issueSortKey(a.issue_id), issueSortKey(b.issue_id)));
    const aggregates = new Map(issue_claims.map(claim => [claim.issue_id, claim]));
    if (aggregates.size !== issue_claims.length || issue_claims.some(claim => !ids.has(claim.issue_id))) fail('Claim issue must exist and have one aggregate');
    const claim_requests = requests.map(value => {
      const row = claimRequestRow(record(value, [...claimKeys, 'request_id', 'payload', 'created_at', 'outcome']));
      const aggregate = aggregates.get(row.issue_id);
      if (!aggregate || row.generation > aggregate.generation || row.revision > aggregate.revision) return fail('Claim receipt exceeds the aggregate counters');
      const operation = parseClaimOperation(JSON.parse(row.payload));
      if (operation.op === 'claim_show' || operation.op === 'claim_list' || operation.request_id !== row.request_id || JSON.stringify(operation) !== row.payload) return fail('Invalid canonical claim request');
      if (operation.op === 'claim_acquire') {
        if (row.outcome !== 'acquired' || operation.issue_id !== row.issue_id || operation.incarnation !== row.incarnation || operation.session_id !== row.session_id || operation.agent_label !== row.agent_label || row.acquired_at !== row.changed_at || row.expires_at !== row.changed_at + operation.ttl) return fail('Claim acquisition receipt differs from the request');
      } else if (operation.op === 'claim_report') {
        const proof = operation.claim_proof;
        if (proof.issue_id !== row.issue_id || proof.incarnation !== row.incarnation || proof.session_id !== row.session_id || proof.generation !== row.generation || row.outcome !== 'renewed') return fail('Claim report receipt differs from the request');
      } else {
        const proof = operation.claim_proof;
        if (proof.issue_id !== row.issue_id || proof.incarnation !== row.incarnation || proof.session_id !== row.session_id || proof.generation !== row.generation || operation.expected_revision + 1 !== row.revision || row.outcome !== (operation.op === 'claim_renew' ? 'renewed' : 'released') || (operation.op === 'claim_renew' && row.expires_at !== row.changed_at + operation.ttl)) return fail('Claim receipt differs from the request');
      }
      return row;
    }).sort((a, b) => compareText(a.request_id, b.request_id));
    if (new Set(claim_requests.map(row => row.request_id)).size !== claim_requests.length) fail('Duplicate claim request ID');
    const revisions = new Set<string>();
    for (const row of claim_requests) {
      const key = JSON.stringify([row.issue_id, row.revision]);
      if (revisions.has(key)) fail('Duplicate claim receipt revision'); revisions.add(key);
    }
    return { ...old, version: 5, issue_claims, claim_requests };
  } catch (error) {
    if (error instanceof PolylinedbError && error.code === 'invalid_snapshot') throw error;
    return fail(error instanceof Error ? error.message : 'Invalid claim snapshot');
  }
}
// Snapshot 5 holds no close records, so conversion leaves every closure empty instead of guessing one.
export function convertSnapshotV5(input: unknown): Snapshot {
  const old = parseSnapshotV5(input);
  return convertSnapshotV6({ ...old, version: 6, issues: old.issues.map(issue => ({ ...issue, closed_at: null, closed_by: null })) });
}
const issueKeys = ['id', ...fields, 'versions', 'created_at', 'created_by', 'updated_at', 'updated_by'];
function parseSnapshotV6(input: unknown): SnapshotV6 {
  const source = record(input, snapshotKeys);
  if (source.version !== 6) return fail('Unsupported snapshot version; convert versions 2, 3, 4 and 5 explicitly');
  if (!Array.isArray(source.issues)) return fail('Snapshot collections must be arrays');
  const closures = new Map<unknown, Record<string, unknown>>();
  const issues = source.issues.map(value => {
    const { closed_at, closed_by, ...issue } = record(value, [...issueKeys, 'closed_at', 'closed_by']);
    if (closed_at !== null) timestamp(closed_at);
    closures.set(issue.id, { closed_at, closed_by });
    return issue;
  });
  const old = parseSnapshotV5({ ...source, version: 5, issues });
  try {
    return { ...old, version: 6, issues: old.issues.map(issue => ({ ...issue, ...parseClosure(closures.get(issue.id) ?? {}, issue.status) })) };
  } catch (error) {
    return fail(error instanceof Error ? error.message : 'Invalid issue closure');
  }
}
// Snapshot 6 predates land order and external resources, so conversion adds empty collections: every issue starts at revision 1 of both.
export function convertSnapshotV6(input: unknown): Snapshot {
  return convertSnapshotV7({ ...parseSnapshotV6(input), version: 7, land_order: [], land_order_revisions: [], land_order_requests: [], issue_resources: [], resource_revisions: [], resource_requests: [] });
}
const snapshotV7Keys = [...snapshotKeys, 'land_order', 'land_order_revisions', 'land_order_requests', 'issue_resources', 'resource_revisions', 'resource_requests'];
/** Rejects a cycle over the union of prerequisite and land-order edges, which the store triggers also refuse. */
function acyclic(ids: ReadonlySet<string>, edges: readonly (readonly [later: string, earlier: string])[]): void {
  const outgoing = new Map<string, string[]>();
  const degree = new Map([...ids].map(id => [id, 0]));
  for (const [later, earlier] of edges) {
    outgoing.set(later, [...outgoing.get(later) ?? [], earlier]);
    degree.set(earlier, (degree.get(earlier) ?? 0) + 1);
  }
  const queue = [...degree].filter(([, count]) => count === 0).map(([id]) => id);
  for (let i = 0; i < queue.length; i++) {
    for (const earlier of outgoing.get(queue[i] ?? '') ?? []) {
      const count = (degree.get(earlier) ?? 0) - 1; degree.set(earlier, count);
      if (count === 0) queue.push(earlier);
    }
  }
  if (queue.length !== ids.size) fail('Prerequisites and land order contain a cycle');
}
function parseSnapshotV7(input: unknown): SnapshotV7 {
  const source = record(input, snapshotV7Keys);
  if (source.version !== 7) return fail('Unsupported snapshot version; convert versions 2, 3, 4, 5 and 6 explicitly');
  const { land_order: edges, land_order_revisions: revisions, land_order_requests: requests, issue_resources: resources, resource_revisions: resourceRevisions, resource_requests: resourceRequests, ...legacy } = source;
  const old = parseSnapshotV6({ ...legacy, version: 6 });
  if (!Array.isArray(edges) || !Array.isArray(revisions) || !Array.isArray(requests)) return fail('Land-order collections must be arrays');
  try {
    const ids = new Set(old.issues.map(issue => issue.id));
    const endpoint = (value: unknown) => { const id = parseIssueId(value); if (!ids.has(id)) return fail('Land-order endpoint does not exist'); return id; };
    const counter = (value: unknown, minimum: number) => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return fail('Invalid land-order revision'); return value; };
    const byIssue = (a: string, b: string) => compareText(issueSortKey(a), issueSortKey(b));
    const land_order_revisions = revisions.map(value => {
      const row = record(value, ['later_id', 'revision']);
      return { later_id: endpoint(row.later_id), revision: counter(row.revision, 2) };
    }).sort((a, b) => byIssue(a.later_id, b.later_id));
    const byId = new Map(land_order_revisions.map(row => [row.later_id, row.revision]));
    if (byId.size !== land_order_revisions.length) fail('Duplicate land-order revision');
    const land_order = edges.map(value => {
      const row = record(value, ['later_id', 'earlier_id']);
      return { later_id: endpoint(row.later_id), earlier_id: endpoint(row.earlier_id) };
    }).sort((a, b) => byIssue(a.later_id, b.later_id) || byIssue(a.earlier_id, b.earlier_id));
    if (new Set(land_order.map(edge => JSON.stringify([edge.later_id, edge.earlier_id]))).size !== land_order.length) fail('Duplicate land-order tuple');
    acyclic(ids, [...old.dependencies.map(edge => [edge.dependent_id, edge.blocker_id] as const), ...land_order.map(edge => [edge.later_id, edge.earlier_id] as const)]);
    const land_order_requests = requests.map((value): LandOrderRequest => {
      const row = record(value, ['request_id', 'actor', 'payload', 'later_id', 'earlier_id', 'result_revision', 'outcome', 'created_at']);
      const request_id = parseRequestId(row.request_id); const later_id = endpoint(row.later_id); const earlier_id = endpoint(row.earlier_id);
      const result_revision = counter(row.result_revision, 2);
      if (result_revision > (byId.get(later_id) ?? 1)) fail('Land-order receipt exceeds the aggregate revision');
      if (typeof row.actor !== 'string' || !row.actor.trim() || /\p{Cc}/u.test(row.actor) || new TextEncoder().encode(row.actor).length > 256 || typeof row.payload !== 'string') return fail('Invalid land-order receipt actor or payload');
      timestamp(row.created_at); if (typeof row.created_at !== 'string') return fail('Invalid land-order timestamp');
      const operation = parseLandOrderOperation(JSON.parse(row.payload));
      if (operation.op === 'land_order_list' || operation.request_id !== request_id || operation.later_id !== later_id || operation.earlier_id !== earlier_id || operation.expected_revision + 1 !== result_revision || JSON.stringify(operation) !== row.payload) return fail('Invalid canonical land-order receipt');
      const outcome = row.outcome;
      if (outcome !== 'added' && outcome !== 'already_present' && outcome !== 'removed' && outcome !== 'already_absent') return fail('Invalid land-order receipt outcome');
      if ((operation.op === 'land_order_add') !== (outcome === 'added' || outcome === 'already_present')) return fail('Land-order receipt outcome differs from the operation');
      return { request_id, actor: row.actor, payload: row.payload, later_id, earlier_id, result_revision, outcome, created_at: row.created_at };
    }).sort((a, b) => compareText(a.request_id, b.request_id));
    if (new Set(land_order_requests.map(row => row.request_id)).size !== land_order_requests.length) fail('Duplicate land-order request ID');
    if (new Set(land_order_requests.map(row => JSON.stringify([row.later_id, row.result_revision]))).size !== land_order_requests.length) fail('Duplicate land-order receipt revision');
    return { ...old, version: 7, land_order, land_order_revisions, land_order_requests, ...parseResources(ids, resources, resourceRevisions, resourceRequests) };
  } catch (error) {
    if (error instanceof PolylinedbError && error.code === 'invalid_snapshot') throw error;
    return fail(error instanceof Error ? error.message : 'Invalid land-order snapshot');
  }
}
function parseResources(ids: ReadonlySet<string>, entries: unknown, revisions: unknown, requests: unknown): Pick<Snapshot, 'issue_resources' | 'resource_revisions' | 'resource_requests'> {
  if (!Array.isArray(entries) || !Array.isArray(revisions) || !Array.isArray(requests)) return fail('Resource collections must be arrays');
  const owner = (value: unknown) => { const id = parseIssueId(value); if (!ids.has(id)) return fail('Resource issue does not exist'); return id; };
  const counter = (value: unknown, minimum: number) => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) return fail('Invalid resource revision'); return value; };
  const byIssue = (a: string, b: string) => compareText(issueSortKey(a), issueSortKey(b));
  const resource_revisions = revisions.map(value => {
    const row = record(value, ['issue_id', 'revision']);
    return { issue_id: owner(row.issue_id), revision: counter(row.revision, 2) };
  }).sort((a, b) => byIssue(a.issue_id, b.issue_id));
  const byId = new Map(resource_revisions.map(row => [row.issue_id, row.revision]));
  if (byId.size !== resource_revisions.length) fail('Duplicate resource revision');
  const keys = ['issue_id', 'seq', 'kind', 'name', 'external_id', 'created_at', 'deleted_at', 'verified_deleted_at', 'verified_by', 'evidence', 'added_at', 'added_by'];
  const issue_resources = entries.map(value => {
    const row = record(value, keys);
    owner(row.issue_id);
    let entry: ResourceEntry;
    try { entry = resourceEntry(row); } catch (error) { return fail(error instanceof Error ? error.message : 'Invalid resource entry'); }
    for (const time of [entry.created_at, entry.deleted_at, entry.verified_deleted_at, entry.added_at]) if (time !== null) timestamp(time);
    return entry;
  }).sort((a, b) => byIssue(a.issue_id, b.issue_id) || a.seq - b.seq);
  const entryKey = (issueId: string, seq: number) => JSON.stringify([issueId, seq]);
  const stored = new Set(issue_resources.map(entry => entryKey(entry.issue_id, entry.seq)));
  if (stored.size !== issue_resources.length) fail('Duplicate resource entry');
  const resource_requests = requests.map((value): ResourceRequest => {
    const row = record(value, ['request_id', 'actor', 'payload', 'issue_id', 'seq', 'result_revision', 'outcome', 'created_at']);
    const request_id = parseRequestId(row.request_id); const issue_id = owner(row.issue_id);
    const seq = counter(row.seq, 1); const result_revision = counter(row.result_revision, 2);
    if (!stored.has(entryKey(issue_id, seq))) fail('Resource receipt names a missing entry');
    if (result_revision > (byId.get(issue_id) ?? 1)) fail('Resource receipt exceeds the aggregate revision');
    if (typeof row.actor !== 'string' || !row.actor.trim() || /\p{Cc}/u.test(row.actor) || new TextEncoder().encode(row.actor).length > 256 || typeof row.payload !== 'string') return fail('Invalid resource receipt actor or payload');
    timestamp(row.created_at); if (typeof row.created_at !== 'string') return fail('Invalid resource timestamp');
    const operation = parseResourceOperation(JSON.parse(row.payload));
    if ((operation.op !== 'resource_add' && operation.op !== 'resource_update') || operation.request_id !== request_id || operation.issue_id !== issue_id
      || (operation.op === 'resource_update' && operation.seq !== seq) || operation.expected_revision + 1 !== result_revision || JSON.stringify(operation) !== row.payload) return fail('Invalid canonical resource receipt');
    const outcome = operation.op === 'resource_add' ? 'added' as const : 'updated' as const;
    if (row.outcome !== outcome) return fail('Resource receipt outcome differs from the operation');
    return { request_id, actor: row.actor, payload: row.payload, issue_id, seq, result_revision, outcome, created_at: row.created_at };
  }).sort((a, b) => compareText(a.request_id, b.request_id));
  if (new Set(resource_requests.map(row => row.request_id)).size !== resource_requests.length) fail('Duplicate resource request ID');
  if (new Set(resource_requests.map(row => JSON.stringify([row.issue_id, row.result_revision]))).size !== resource_requests.length) fail('Duplicate resource receipt revision');
  return { issue_resources, resource_revisions, resource_requests };
}
// Snapshot 7 predates comment edits, so every comment converts as never edited.
export function convertSnapshotV7(input: unknown): Snapshot {
  const old = parseSnapshotV7(input);
  return convertSnapshotV8({ ...old, version: 8, comments: old.comments.map(comment => ({ ...comment, version: 1, updated_at: null, updated_by: null })) });
}
const commentKeys = ['id', 'issue_id', 'body', 'created_at', 'created_by'];
function parseSnapshotV8(input: unknown): SnapshotV8 {
  const source = record(input, snapshotV7Keys);
  if (source.version !== 8) return fail('Unsupported snapshot version; convert versions 2, 3, 4, 5, 6 and 7 explicitly');
  if (!Array.isArray(source.comments)) return fail('Snapshot collections must be arrays');
  const edits = new Map<unknown, Record<string, unknown>>();
  const comments = source.comments.map(value => {
    const { version, updated_at, updated_by, ...comment } = record(value, [...commentKeys, 'version', 'updated_at', 'updated_by']);
    if (updated_at !== null) timestamp(updated_at);
    edits.set(comment.id, { version, updated_at, updated_by });
    return comment;
  });
  const old = parseSnapshotV7({ ...source, version: 7, comments });
  return { ...old, version: 8, comments: old.comments.map(comment => {
    // commentRow also refuses an editor other than the author, because only the author edits a comment.
    let edited: Comment;
    try { edited = commentRow({ ...comment, ...edits.get(comment.id) }); } catch { return fail('Invalid comment edit'); }
    const { version, updated_at, updated_by } = edited;
    if (version === undefined || updated_at === undefined || updated_by === undefined) return fail('Invalid comment edit');
    return { id: edited.id, issue_id: edited.issue_id, body: edited.body, created_at: edited.created_at, created_by: edited.created_by, version, updated_at, updated_by };
  }) };
}
// Snapshot 8 predates posts, so every comment converts with no handle, no via, and no reply, and no comment has a star.
export function convertSnapshotV8(input: unknown): Snapshot {
  const old = parseSnapshotV8(input);
  return convertSnapshotV9({ ...old, version: 9, comments: old.comments.map(comment => ({ ...comment, handle: null, via: null, reply_to: null })), stars: [] });
}
/** Gives each comment its distance from the comment that starts its reply chain, refusing a missing target, a target on another issue, and a cycle. */
function replyDepths(comments: readonly StoredComment[]): Map<string, number> {
  const byId = new Map(comments.map(comment => [comment.id, comment]));
  const depths = new Map<string, number>();
  for (const comment of comments) {
    const chain: StoredComment[] = []; const seen = new Set<string>();
    let current = comment; let depth = -1;
    for (;;) {
      const known = depths.get(current.id);
      if (known !== undefined) { depth = known; break; }
      if (seen.has(current.id)) return fail('Replies form a cycle');
      seen.add(current.id); chain.push(current);
      if (current.reply_to === null) break;
      const target = byId.get(current.reply_to);
      if (!target || target.issue_id !== current.issue_id) return fail('A reply must name a comment on the same issue');
      current = target;
    }
    for (const link of chain.reverse()) depths.set(link.id, ++depth);
  }
  return depths;
}
const starKeys = ['comment_id', 'starrer', 'handle', 'actor', 'created_at'];
function parseSnapshotV9(input: unknown): SnapshotV9 {
  const source = record(input, [...snapshotV7Keys, 'stars']);
  if (source.version !== 9) return fail('Unsupported snapshot version; convert versions 2, 3, 4, 5, 6, 7 and 8 explicitly');
  const { stars: starRows, ...rest } = source;
  if (!Array.isArray(source.comments) || !Array.isArray(starRows)) return fail('Snapshot collections must be arrays');
  const posts = new Map<unknown, Record<string, unknown>>();
  const comments = source.comments.map(value => {
    const { handle, via, reply_to, ...comment } = record(value, [...commentKeys, 'version', 'updated_at', 'updated_by', 'handle', 'via', 'reply_to']);
    posts.set(comment.id, { handle, via, reply_to });
    return comment;
  });
  const old = parseSnapshotV8({ ...rest, version: 8, comments });
  const stored = old.comments.map(comment => {
    try { return storedCommentRow({ ...comment, ...posts.get(comment.id) }); } catch { return fail('Invalid post fields'); }
  });
  const depths = replyDepths(stored);
  const byId = new Set(stored.map(comment => comment.id));
  const stars = starRows.map(value => {
    const row = record(value, starKeys);
    timestamp(row.created_at);
    let star: Star;
    try { star = starRow(row); } catch { return fail('Invalid star'); }
    if (!byId.has(star.comment_id)) fail('Star comment does not exist');
    return star;
  }).sort((a, b) => compareText(a.comment_id, b.comment_id) || compareText(a.starrer, b.starrer));
  if (new Set(stars.map(star => JSON.stringify([star.comment_id, star.starrer]))).size !== stars.length) fail('Duplicate star');
  // A target sorts before its replies, so every importer can insert comments in snapshot order.
  return { ...old, version: 9, comments: stored.sort((a, b) => (depths.get(a.id) ?? 0) - (depths.get(b.id) ?? 0) || compareId(a, b)), stars };
}
// Snapshot 9 predates asks and checks, so no issue has an item.
export function convertSnapshotV9(input: unknown): Snapshot {
  return parseSnapshot({ ...parseSnapshotV9(input), version: 10, issue_items: [] });
}
const itemKeys = ['issue_id', 'n', 'kind', 'text', 'options', 'recommended', 'state', 'answer', 'note', 'request_id', 'created_at', 'created_by', 'resolved_at', 'resolved_by'];
export function parseSnapshot(input: unknown): Snapshot {
  const source = record(input, [...snapshotV7Keys, 'stars', 'issue_items']);
  if (source.version !== 10) return fail('Unsupported snapshot version; convert versions 2, 3, 4, 5, 6, 7, 8 and 9 explicitly');
  const { issue_items: itemRows, ...rest } = source;
  const old = parseSnapshotV9({ ...rest, version: 9 });
  if (!Array.isArray(itemRows)) return fail('Snapshot collections must be arrays');
  const ids = new Set(old.issues.map(issue => issue.id));
  const issue_items = itemRows.map((value): SnapshotItem => {
    const row = record(value, itemKeys);
    timestamp(row.created_at); if (row.resolved_at !== null) timestamp(row.resolved_at);
    if (row.options !== null && (!Array.isArray(row.options) || row.options.length < 2 || row.options.length > 8 || row.options.some(option => typeof option !== 'string' || option.length === 0))) return fail('Invalid item options');
    let item: SnapshotItem;
    try { item = { ...itemRow({ ...row, options_json: row.options === null ? null : JSON.stringify(row.options) }), request_id: parseRequestId(row.request_id) }; }
    catch { return fail('Invalid item'); }
    if (!ids.has(item.issue_id)) fail('Item issue does not exist');
    const resolvedStates = item.kind === 'ask' ? ['answered', 'withdrawn'] : ['met', 'waived'];
    if ((item.state !== 'open' && !resolvedStates.includes(item.state)) || (item.kind !== 'ask' && item.options !== null) || (item.recommended !== null && !item.options?.includes(item.recommended))
      || (item.state === 'open') !== (item.resolved_at === null) || (item.resolved_at === null) !== (item.resolved_by === null) || (item.state === 'answered') !== (item.answer !== null)
      || (item.state === 'open' && item.note !== null) || ((item.state === 'met' || item.state === 'waived' || item.state === 'withdrawn') && item.note === null)) fail('Invalid item state');
    return item;
  }).sort((a, b) => compareText(issueSortKey(a.issue_id), issueSortKey(b.issue_id)) || a.n - b.n);
  if (new Set(issue_items.map(item => JSON.stringify([item.issue_id, item.n]))).size !== issue_items.length) fail('Duplicate item');
  if (new Set(issue_items.map(item => item.request_id)).size !== issue_items.length) fail('Duplicate item request ID');
  return { ...old, version: 10, issue_items };
}
export function canonicalSnapshot(snapshot: Snapshot): string { return JSON.stringify(parseSnapshot(snapshot)); }
export function canonicalSnapshotV9(input: unknown): string { return JSON.stringify(parseSnapshotV9(input)); }
export function canonicalSnapshotV8(input: unknown): string { return JSON.stringify(parseSnapshotV8(input)); }
export function canonicalSnapshotV7(input: unknown): string { return JSON.stringify(parseSnapshotV7(input)); }
export function canonicalSnapshotV5(input: unknown): string { return JSON.stringify(parseSnapshotV5(input)); }
export function canonicalSnapshotV6(input: unknown): string { return JSON.stringify(parseSnapshotV6(input)); }
