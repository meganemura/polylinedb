// Holds records in an older schema: current operations as an earlier release issued them, and schema 6, 7, 8 or 9 stores made from a current one.
import type { DatabaseSync } from 'node:sqlite';
import { CHANGE_STATEMENTS } from '../../src/records/changes-sql.ts';
import { SCHEMA_V9_ADDITIONS } from '../../src/records/schema.ts';
import { SCHEMA_V8_STATEMENTS } from '../../src/records/schema-v8.ts';
import { SCHEMA_V9_STATEMENTS } from '../../src/records/schema-v9.ts';
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

// Schema 10 rebuilt change_events, so the downgrade runs the schema 9 statements of that table and of every trigger that names it, keeping each event row.
export function downgradeToSchema9(database: DatabaseSync): void {
  const named = (prefix: string) => SCHEMA_V9_STATEMENTS.filter(sql => sql.startsWith(prefix));
  const table = [...named('CREATE TABLE change_events '), ...named('ALTER TABLE change_events ')];
  const triggers = named('CREATE TRIGGER ').filter(sql => /\bchange_events\b/.test(sql));
  if (table.length !== 2 || triggers.length === 0) throw new Error('Schema 9 has no change feed statements');
  database.exec('BEGIN; DROP TRIGGER comments_change_update');
  for (const sql of triggers) database.exec(`DROP TRIGGER IF EXISTS ${/^CREATE TRIGGER (\w+)/.exec(sql)?.[1] ?? ''}`);
  database.exec('CREATE TEMP TABLE kept_events AS SELECT * FROM change_events; DROP TABLE change_events');
  for (const sql of table) database.exec(sql);
  database.exec('INSERT INTO change_events SELECT * FROM kept_events; DROP TABLE kept_events');
  for (const sql of triggers) database.exec(sql);
  database.exec('ALTER TABLE comments DROP COLUMN updated_by; ALTER TABLE comments DROP COLUMN updated_at; ALTER TABLE comments DROP COLUMN version; UPDATE schema_version SET version = 9; COMMIT');
}

// Schema 9 replaced the prerequisite cycle trigger, so the downgrade restores the schema 8 text of it.
export function downgradeToSchema8(database: DatabaseSync): void {
  downgradeToSchema9(database);
  const order = { TRIGGER: 0, INDEX: 1, TABLE: 2 } as const;
  const objects = SCHEMA_V9_ADDITIONS.flatMap(sql => {
    const match = /^CREATE (TABLE|TRIGGER|INDEX) (\w+)/.exec(sql);
    return match?.[1] && match[2] ? [{ type: match[1] as keyof typeof order, name: match[2] }] : [];
  }).sort((a, b) => order[a.type] - order[b.type]);
  const acyclic = SCHEMA_V8_STATEMENTS.find(sql => sql.startsWith('CREATE TRIGGER dependencies_acyclic'));
  if (!acyclic) throw new Error('Schema 8 has no prerequisite cycle trigger');
  database.exec('BEGIN');
  for (const { type, name } of objects) database.exec(`DROP ${type} IF EXISTS ${name}`);
  database.exec(acyclic);
  database.exec('ALTER TABLE change_events DROP COLUMN relation; UPDATE schema_version SET version = 8; COMMIT');
}

// The closure check belongs to closed_by, so dropping closed_by first leaves closed_at unreferenced.
export function downgradeToSchema7(database: DatabaseSync): void {
  downgradeToSchema8(database);
  database.exec('BEGIN; ALTER TABLE issues DROP COLUMN closed_by; ALTER TABLE issues DROP COLUMN closed_at; UPDATE schema_version SET version = 7; COMMIT');
}

export function downgradeToSchema6(database: DatabaseSync): void {
  downgradeToSchema7(database);
  const objects = CHANGE_STATEMENTS.map(sql => /^CREATE (TABLE|TRIGGER) (\w+)/.exec(sql)).map(match => {
    if (!match?.[1] || !match[2]) throw new Error('Unexpected change feed statement');
    return { type: match[1], name: match[2] };
  });
  database.exec('BEGIN');
  for (const { type, name } of [...objects].sort((a, b) => a.type === b.type ? 0 : a.type === 'TRIGGER' ? -1 : 1)) database.exec(`DROP ${type} ${name}`);
  database.exec('UPDATE schema_version SET version = 6; COMMIT');
}
