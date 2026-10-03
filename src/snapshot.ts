// Owns portable snapshot validation and canonical form; storage and file access belong to callers.
import { commentRow, issueRow, PolylinedbError } from './issues.ts';
import type { Comment, Issue } from './issues.ts';
import { fields } from './schema.ts';

export type Snapshot = { format: 'polylinedb.snapshot'; version: 1; issues: readonly Issue[]; comments: readonly Comment[] };
export type SnapshotImport = { result: 'imported' | 'already_present'; issues: number; comments: number; sha256: string };
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
export function parseSnapshot(input: unknown): Snapshot {
  const source = record(input, ['format', 'version', 'issues', 'comments']);
  if (source.format !== 'polylinedb.snapshot' || source.version !== 1) return fail('Unsupported snapshot format or version');
  if (!Array.isArray(source.issues) || !Array.isArray(source.comments)) return fail('Issues and comments must be arrays');
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
    return { format: 'polylinedb.snapshot', version: 1, issues: issues.sort(compareId), comments: comments.sort(compareId) };
  } catch (error) {
    if (error instanceof PolylinedbError && error.code === 'invalid_snapshot') throw error;
    return fail(error instanceof Error ? error.message : 'Invalid snapshot');
  }
}
function compareId(a: { id: string }, b: { id: string }): number { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }
export function canonicalSnapshot(snapshot: Snapshot): string { return JSON.stringify(parseSnapshot(snapshot)); }
