// Owns the stored link from an issue to the issue it was found while working on, and the read that show returns in both directions.
// create writes the link with the issue; nothing changes it later, so it carries no version and records no change event.
import { PolylinedbError } from './errors.ts';
import { parseIssueId } from './issue-id.ts';
import type { SqlExecutor } from './sql.ts';

export const DISCOVERY_STATEMENTS = [
  `CREATE TABLE issue_discoveries (
    issue_id TEXT PRIMARY KEY NOT NULL REFERENCES issues(id),
    discovered_from TEXT NOT NULL REFERENCES issues(id) CHECK(discovered_from <> issue_id)
  )`,
  'CREATE INDEX issue_discoveries_source ON issue_discoveries(discovered_from, issue_id)',
];

export type IssueDiscovery = { issue_id: string; discovered_from: string };
/** Where an issue was found, and the issues found while working on it, in issue order. */
export type Discovery = { discovered_from: string | null; discovered: string[] };

export function discoveryRow(row: Record<string, unknown>): IssueDiscovery {
  try { return { issue_id: parseIssueId(row.issue_id), discovered_from: parseIssueId(row.discovered_from) }; }
  catch { throw new PolylinedbError('invalid_store', 'Stored discovery is invalid', 500); }
}

export async function readDiscovery(db: SqlExecutor, issueId: string): Promise<Discovery> {
  const [source, found] = await db.batch([
    { sql: 'SELECT issue_id, discovered_from FROM issue_discoveries WHERE issue_id = ?', params: [issueId] },
    { sql: `SELECT issue_discoveries.issue_id, issue_discoveries.discovered_from FROM issue_discoveries JOIN issues ON issues.id = issue_discoveries.issue_id
      WHERE issue_discoveries.discovered_from = ? ORDER BY issues.sort_key`, params: [issueId] },
  ]);
  const from = source?.rows[0];
  return { discovered_from: from === undefined ? null : discoveryRow(from).discovered_from, discovered: (found?.rows ?? []).map(row => discoveryRow(row).issue_id) };
}
