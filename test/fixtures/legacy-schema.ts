// Holds records in an older schema: current operations as an earlier release issued them, and schema 6, 7, 8, 9 or 10 stores made from a current one.
import type { DatabaseSync } from 'node:sqlite';
import { CHANGE_KIND_REBUILD_STATEMENTS, CHANGE_STATEMENTS } from '../../src/records/changes-sql.ts';
import { SCHEMA_V9_ADDITIONS } from '../../src/records/schema.ts';
import { SCHEMA_V8_STATEMENTS } from '../../src/records/schema-v8.ts';
import { SCHEMA_V9_STATEMENTS } from '../../src/records/schema-v9.ts';
import { SCHEMA_V10_STATEMENTS } from '../../src/records/schema-v10.ts';
import type { SqlExecutor } from '../../src/records/persistence.ts';

/** Writes a comment as a release before posts did, so it runs on a schema that lacks the edit or post columns; recorded writes its event as a comment operation would. */
export async function legacyComment(db: SqlExecutor, comment: { issue_id: string; body: string; actor: string; recorded?: boolean }): Promise<string> {
  const id = crypto.randomUUID();
  const insert = { sql: 'INSERT INTO comments(id,issue_id,body,created_at,created_by) VALUES (?,?,?,?,?)', params: [id, comment.issue_id, comment.body, new Date().toISOString(), comment.actor] };
  await db.batch(comment.recorded === false ? [insert]
    : [{ sql: 'INSERT INTO change_writer(singleton,actor) VALUES (1,?)', params: [comment.actor] }, insert, { sql: 'DELETE FROM change_writer', params: [] }]);
  return id;
}

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

// Schema 11 rebuilt change_events for the star kinds, so the downgrade drops the stars and every star event, then runs the schema 10 rebuild and recreates the schema 10 triggers that name the table.
export function downgradeToSchema10(database: DatabaseSync): void {
  const name = (sql: string) => /^CREATE TRIGGER (\w+)/.exec(sql)?.[1] ?? '';
  const triggers = SCHEMA_V10_STATEMENTS.filter((sql, index) => sql.startsWith('CREATE TRIGGER ') && /\bchange_events\b/.test(sql)
    && !SCHEMA_V10_STATEMENTS.slice(index + 1).some(later => name(later) === name(sql)));
  if (triggers.length === 0) throw new Error('Schema 10 has no change feed triggers');
  database.exec("BEGIN; DROP TRIGGER stars_change_insert; DROP TRIGGER stars_change_delete; DROP TABLE stars; DELETE FROM change_events WHERE kind IN ('starred','unstarred')");
  for (const sql of triggers) database.exec(`DROP TRIGGER ${name(sql)}`);
  for (const sql of CHANGE_KIND_REBUILD_STATEMENTS) database.exec(sql);
  for (const sql of triggers) database.exec(sql);
  database.exec('DROP TRIGGER comments_reply_on_issue; DROP INDEX comments_posts; ALTER TABLE comments DROP COLUMN reply_to; ALTER TABLE comments DROP COLUMN via; ALTER TABLE comments DROP COLUMN handle; UPDATE schema_version SET version = 10; COMMIT');
}

// Schema 10 rebuilt change_events, so the downgrade runs the schema 9 statements of that table and of every trigger that names it, keeping each event row.
export function downgradeToSchema9(database: DatabaseSync): void {
  downgradeToSchema10(database);
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
