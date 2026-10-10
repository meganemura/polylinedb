// Turns a current store into schema 6 so tests can hold schema 6 records written through the public operations.
import type { DatabaseSync } from 'node:sqlite';
import { CHANGE_STATEMENTS } from '../../src/records/changes-sql.ts';

export function downgradeToSchema6(database: DatabaseSync): void {
  const objects = CHANGE_STATEMENTS.map(sql => /^CREATE (TABLE|TRIGGER) (\w+)/.exec(sql)).map(match => {
    if (!match?.[1] || !match[2]) throw new Error('Unexpected change feed statement');
    return { type: match[1], name: match[2] };
  });
  database.exec('BEGIN');
  for (const { type, name } of [...objects].sort((a, b) => a.type === b.type ? 0 : a.type === 'TRIGGER' ? -1 : 1)) database.exec(`DROP ${type} ${name}`);
  database.exec('UPDATE schema_version SET version = 6; COMMIT');
}
