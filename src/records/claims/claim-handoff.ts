// Owns the queue handoff: one atomic write that records the tip and result comments, moves the issue to the landing
// queue labels, and releases the claim. The release receipt is the idempotency record, so the schema does not change.
import { PolylinedbError, requireFields } from '../store/errors.ts';
import { parseRequestId } from '../store/issue-id.ts';
import { issueQueries } from '../store/issue-queries.ts';
import { claimMutationStatements } from './claims-sql.ts';
import { recordingChanges } from '../store/changes-sql.ts';
import { commentRow, issueRow } from '../store/issue-record.ts';
import type { ClaimProof } from './claims-sql.ts';
import type { Comment, Issue } from '../store/issue-record.ts';
import type { SqlExecutor, SqlStatement } from '../store/sql.ts';
import { decideReplay, readyLabel } from '../../transition/index.ts';

export const mainWaitLabel = 'main-wait';
export type ClaimHandoff = { op: 'claim_handoff'; claim_proof: ClaimProof; expected_revision: number; request_id: string; tip: string; summary?: string };
export type HandoffParts = { issue: Issue; comments: Comment[] };

const invalid = (message: string): never => { throw new PolylinedbError('invalid_input', message); };

export function parseHandoff(input: Record<string, unknown>, base: { claim_proof: ClaimProof; expected_revision: number; request_id: string }, allowed: readonly string[], required: readonly string[]): ClaimHandoff {
  requireFields(input, allowed, required);
  if (typeof input.tip !== 'string' || !/^[0-9a-f]{7,40}$/.test(input.tip)) return invalid('tip must be a lowercase hexadecimal commit SHA of 7 through 40 digits');
  if (input.summary === undefined) return { op: 'claim_handoff', ...base, tip: input.tip };
  const summary = input.summary;
  if (typeof summary !== 'string' || summary.trim().length === 0) return invalid('summary must be a nonempty string');
  if (new TextEncoder().encode(summary).length > 65536) return invalid('summary exceeds 65536 UTF-8 bytes');
  if (summary.includes('\u0000')) return invalid('summary must not contain NUL');
  return { op: 'claim_handoff', ...base, tip: input.tip, summary };
}

// The comment IDs come from the request ID, so a replay finds the comments its first attempt wrote.
async function commentIds(requestId: string): Promise<[string, string]> {
  const derive = async (part: string) => {
    const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`claim_handoff:${requestId}:${part}`)))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    return parseRequestId(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`);
  };
  return [await derive('tip'), await derive('summary')];
}

function queueLabels(labels: readonly string[]): string[] {
  return [...new Set([...labels.filter(label => label !== readyLabel), mainWaitLabel])].sort();
}

async function readParts(db: SqlExecutor, issueId: string, ids: readonly string[]): Promise<HandoffParts> {
  const [issues, comments] = await db.batch([
    { sql: 'SELECT * FROM issues WHERE id = ?', params: [issueId] },
    { sql: `SELECT * FROM comments WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at, id`, params: [...ids] },
  ]);
  const row = issues?.rows[0];
  if (!row) throw new PolylinedbError('not_found', 'Issue was not found', 404, { id: issueId });
  return { issue: issueRow(row), comments: (comments?.rows ?? []).map(commentRow) };
}

export type HandoffAttempt = { kind: 'done'; receipt: Record<string, unknown>; parts: HandoffParts }
  | { kind: 'replay'; receipt: Record<string, unknown>; parts: HandoffParts }
  | { kind: 'rejected'; observed: Record<string, unknown> | undefined; issue: Issue };

// Reads the issue, then writes the release receipt only while the status and label versions it read still hold.
// Every other write in the batch depends on that receipt, and the last statement aborts the batch if any write is missing.
export async function attemptHandoff(db: SqlExecutor, operation: ClaimHandoff, actor: string, observation: SqlStatement,
  isDuplicate: (error: unknown) => boolean): Promise<HandoffAttempt> {
  const issueId = operation.claim_proof.issue_id;
  const payload = JSON.stringify(operation);
  const [tipId, summaryId] = await commentIds(operation.request_id);
  const ids = operation.summary === undefined ? [tipId] : [tipId, summaryId];
  const replay = async (): Promise<HandoffAttempt> => {
    const row = (await db.reads.all(issueQueries.claimRequest, { request_id: operation.request_id }))[0];
    if (!row) throw new PolylinedbError('storage_error', 'Committed claim receipt is unavailable', 503);
    if (decideReplay({ actor: String(row.actor), payload: String(row.payload) }, actor, payload) === 'request_conflict') {
      throw new PolylinedbError('claim_request_conflict', 'The request ID belongs to a different actor, session, or payload', 409);
    }
    return { kind: 'replay', receipt: row, parts: await readParts(db, issueId, ids) };
  };
  const current = (await readParts(db, issueId, [])).issue;
  const labels = queueLabels(current.labels);
  const labelsJson = JSON.stringify(labels);
  const statusMoves = current.status !== 'open' ? 1 : 0;
  const labelsMove = JSON.stringify(current.labels) !== labelsJson ? 1 : 0;
  const gate: SqlStatement = { sql: "EXISTS(SELECT 1 FROM issues WHERE id = ? AND status <> 'closed' AND status_v = ? AND labels_v = ? AND status_v < 9007199254740991 AND labels_v < 9007199254740991)",
    params: [issueId, current.versions.status, current.versions.labels] };
  const release = { op: 'claim_release' as const, claim_proof: operation.claim_proof, expected_revision: operation.expected_revision, request_id: operation.request_id };
  const claimStatements = claimMutationStatements(release, actor, gate, payload);
  const now = Date.now();
  const receipt = 'EXISTS(SELECT 1 FROM claim_requests WHERE request_id = ?)';
  const comment = (id: string, body: string, at: number): SqlStatement => ({ sql: `INSERT INTO comments(id, issue_id, body, created_at, created_by)
    SELECT ?, ?, ?, ?, ? WHERE ${receipt}`, params: [id, issueId, body, new Date(at).toISOString(), actor, operation.request_id] });
  const writes: SqlStatement[] = [
    comment(tipId, `tip: ${operation.tip}`, now),
    ...(operation.summary === undefined ? [] : [comment(summaryId, operation.summary, now + 1)]),
    ...(statusMoves || labelsMove ? [{ sql: `UPDATE issues SET status = 'open', status_v = status_v + ?, labels_json = ?, labels_v = labels_v + ?,
      updated_by = ?, updated_at = ?, closed_at = NULL, closed_by = NULL WHERE id = ? AND ${receipt}`,
    params: [statusMoves, labelsJson, labelsMove, actor, new Date(now).toISOString(), issueId, operation.request_id] }] : []),
    { sql: `INSERT INTO schema_version(version) SELECT 0 WHERE ${receipt} AND ((SELECT COUNT(*) FROM comments WHERE id IN (${ids.map(() => '?').join(',')})) <> ?
      OR NOT EXISTS(SELECT 1 FROM issues WHERE id = ? AND status = 'open' AND labels_json = ?))`,
    params: [operation.request_id, ...ids, ids.length, issueId, labelsJson] },
  ];
  let results;
  try { results = await recordingChanges(db, actor).batch([...claimStatements, ...writes, observation]); }
  catch (error) { if (isDuplicate(error)) return replay(); throw error; }
  const row = results[claimStatements.length - 1]?.rows[0];
  if (row) return { kind: 'done', receipt: row, parts: await readParts(db, issueId, ids) };
  return { kind: 'rejected', observed: results.at(-1)?.rows[0], issue: current };
}
