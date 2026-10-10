// Holds records in an older schema: current operations as an earlier release issued them, and a schema 6 store made from a current one.
import type { DatabaseSync } from 'node:sqlite';
import { CHANGE_STATEMENTS } from '../../src/records/changes-sql.ts';
import type { SqlExecutor } from '../../src/records/persistence.ts';

export function withoutChangeWriter(db: SqlExecutor): SqlExecutor {
  return {
    reads: db.reads,
    async batch(statements) {
      const writer = statements.map(statement => /\bchange_writer\b/.test(statement.sql));
      const results = await db.batch(statements.filter((_, index) => !writer[index]));
      let next = 0;
      return writer.map(skipped => skipped ? { rows: [] } : results[next++] ?? { rows: [] });
    },
  };
}

export function downgradeToSchema6(database: DatabaseSync): void {
  const objects = CHANGE_STATEMENTS.map(sql => /^CREATE (TABLE|TRIGGER) (\w+)/.exec(sql)).map(match => {
    if (!match?.[1] || !match[2]) throw new Error('Unexpected change feed statement');
    return { type: match[1], name: match[2] };
  });
  database.exec('BEGIN');
  for (const { type, name } of [...objects].sort((a, b) => a.type === b.type ? 0 : a.type === 'TRIGGER' ? -1 : 1)) database.exec(`DROP ${type} ${name}`);
  database.exec('UPDATE schema_version SET version = 6; COMMIT');
}
