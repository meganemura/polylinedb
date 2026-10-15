// Wraps a store executor with a known change feed defect; local SQLite and workerd D1 run the same injections.
import assert, { AssertionError } from 'node:assert/strict';
import type { SqlExecutor } from '../../src/records/persistence.ts';
import { runChangeFeedFlow } from './change-feed-flow.ts';

export type FeedDefect = 'drop-one-event' | 'event-on-rejected-write';

// The create replay is the first mutation that records nothing; the request_conflict create is the second.
const requestConflictMutation = 2;

async function maxSeq(db: SqlExecutor): Promise<number> {
  const rows = (await db.batch([{ sql: 'SELECT COALESCE(MAX(seq), 0) AS seq FROM change_events', params: [] }]))[0]?.rows ?? [];
  const seq = rows[0]?.seq;
  return typeof seq === 'number' ? seq : 0;
}

function injectFeedDefect(db: SqlExecutor, defect: FeedDefect): SqlExecutor {
  let dropped = false;
  let silentMutations = 0;
  return {
    reads: db.reads,
    async batch(statements) {
      const mutation = statements.some(statement => statement.sql.startsWith('INSERT INTO change_writer'));
      const before = mutation ? await maxSeq(db) : 0;
      const results = await db.batch(statements);
      if (!mutation) return results;
      const after = await maxSeq(db);
      if (defect === 'drop-one-event' && !dropped && after > before) {
        dropped = true;
        await db.batch([{ sql: 'DELETE FROM change_events WHERE seq = (SELECT MAX(seq) FROM change_events)', params: [] }]);
      }
      if (defect === 'event-on-rejected-write' && after === before) {
        silentMutations += 1;
        if (silentMutations === requestConflictMutation) {
          await db.batch([{
            sql: `INSERT INTO change_events(issue_id, kind, fields_json, occurred_at, actor)
              SELECT id, 'commented', '[]', unixepoch(), 'defect' FROM issues ORDER BY id LIMIT 1`,
            params: [],
          }]);
        }
      }
      return results;
    },
  };
}

export const feedDefects: { defect: FeedDefect; failure: RegExp }[] = [
  { defect: 'drop-one-event', failure: /issue_id: 'cf-1'[\s\S]*kind: 'created'/ },
  { defect: 'event-on-rejected-write', failure: /rejected request_conflict recorded no event/ },
];

export async function failsChangeFeedContract(db: SqlExecutor, defect: FeedDefect, failure: RegExp): Promise<void> {
  await assert.rejects(() => runChangeFeedFlow(injectFeedDefect(db, defect)), (error: unknown) => {
    assert.ok(error instanceof AssertionError, error instanceof Error ? error.message : 'the contract did not fail an assertion');
    assert.match(error.message, failure);
    return true;
  });
}
