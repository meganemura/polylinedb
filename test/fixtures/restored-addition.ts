// Builds synthetic stores for restored-D1 addition tests; each engine supplies its own query and batch ports.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { executeOperation, parseOperation } from '../../src/records/index.ts';
import { executeMemoryOperation, parseMemoryOperation } from '../../src/records/memories.ts';
import { initializeStore, openStore } from '../../src/local-store/index.ts';
import { addConnection, defaultConnection } from '../../src/workspace/index.ts';
import type { Snapshot } from '../../src/records/persistence.ts';
import type { Statement } from '../../scripts/d1-additive-merge.ts';
import type { Batch } from '../../scripts/d1-restored-addition.ts';

export type Store = ReturnType<typeof openStore>;

/** The release 0.1.0 operator's restore of one snapshot 3 input into schema 3, from record-release-0.1.0-restore.ts. */
export const legacyRestore: { schema_sql: string; input: unknown; sha256: string; writes: Statement[] } = JSON.parse(readFileSync(new URL('release-0.1.0-restore.json', import.meta.url), 'utf8'));

export async function populate(store: Store, prefix: string): Promise<void> {
  const run = (operation: unknown, actor = `${prefix}-author`) => executeOperation(store.db, parseOperation(operation), actor);
  const created = await run({ op: 'create', prefix, request_id: randomUUID(), tool: 'fixture', project: 'synthetic', body: `${prefix} epic 日本語`, type: 'epic' });
  assert.ok('issue' in created);
  const epic = created.issue.id;
  await run({ op: 'update', id: epic, changes: [{ field: 'body', value: `${prefix} revised`, expected: 1 }] }, `${prefix}-editor`);
  await run({ op: 'create', prefix, parent: epic, request_id: randomUUID(), tool: 'fixture', project: 'synthetic', body: `${prefix} child` });
  await run({ op: 'dependency_add', dependent_id: `${epic}.1`, blocker_id: epic, expected_revision: 1, request_id: randomUUID() });
  await run({ op: 'comment', id: epic, body: `${prefix} comment` }, `${prefix}-commenter`);
  const scope = await run({ op: 'claim_show', issue_id: epic });
  assert.ok('claim' in scope);
  const session = randomUUID();
  await run({ op: 'claim_acquire', issue_id: epic, incarnation: scope.claim.store_incarnation, session_id: session, request_id: randomUUID(), agent_label: 'Codex' });
  await run({ op: 'claim_release', claim_proof: { issue_id: epic, incarnation: scope.claim.store_incarnation, session_id: session, generation: 1 }, expected_revision: 1, request_id: randomUUID() });
  const memory = (prefix: string) => executeMemoryOperation(store.db, parseMemoryOperation({ op: 'memory_create', prefix, request_id: randomUUID(), project: 'synthetic', title: `${prefix} title`, body: `${prefix} body` }), `${prefix}-memory-author`);
  const deleted = await memory(prefix);
  assert.ok('memory' in deleted);
  await executeMemoryOperation(store.db, parseMemoryOperation({ op: 'memory_delete', project: 'synthetic', id: deleted.memory.id, expected: 1 }), `${prefix}-memory-editor`);
  await memory(`${prefix}live`);
}

export async function localStore(root: string, name: string, prefix?: string): Promise<{ path: string; store: Store }> {
  const location = { directory: join(root, name) };
  const { database_path: path } = initializeStore(location);
  const store = openStore(location);
  if (prefix) await populate(store, prefix);
  return { path, store };
}

/** A null prefix writes an empty store. */
export async function originalInput(root: string, prefix: string | null = 'dst'): Promise<{ path: string; snapshot: Snapshot }> {
  const name = `original-${prefix ?? 'empty'}`;
  const { store } = await localStore(root, name, prefix ?? undefined);
  try {
    const snapshot = store.exportSnapshot();
    const path = join(root, `${name}.json`);
    writeFileSync(path, JSON.stringify(snapshot));
    return { path, snapshot };
  } finally { store.close(); }
}

export function privateDirectory(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(path, { mode: 0o700 });
  return path;
}

/** Private connection settings whose user default selects the source store, so routing has one step that tests can observe. */
export function routingEnvironment(root: string, sourcePath: string): NodeJS.ProcessEnv {
  const environment = { XDG_CONFIG_HOME: privateDirectory(root, `config-${randomUUID()}`) };
  addConnection('cloud', { kind: 'cloud', url: 'https://issues.example.invalid' }, environment);
  addConnection('home', { kind: 'local', data_dir: dirname(sourcePath) }, environment);
  defaultConnection('home', environment);
  return environment;
}

export const failingStatement: Statement = { sql: 'INSERT INTO schema_version(version) VALUES (0)', params: [] };

export function failAt(batch: Batch, index: number): Batch {
  return statements => batch(isAddition(statements) ? statements.map((statement, position) => position === index ? failingStatement : statement) : statements);
}

export function loseResponse(batch: Batch, isTarget: (statements: readonly Statement[]) => boolean): Batch {
  let lost = false;
  return async statements => {
    const results = await batch(statements);
    if (!lost && isTarget(statements)) { lost = true; throw new Error('response lost'); }
    return results;
  };
}

export const isAddition = (statements: readonly Statement[]) => statements.some(statement => statement.sql.startsWith('ALTER TABLE'));

/** Triggers can forbid an update or a delete, so the last form copies the row under a new key. Generic statements give every guarded range the same race. */
export function rowChange(table: string, columns: readonly { name: string; type: string; pk: number }[]): string[] {
  const text = columns.filter(column => column.pk === 0 && column.type === 'TEXT').map(column => column.name);
  const target = `rowid = (SELECT max(rowid) FROM ${table})`;
  const names = columns.map(column => column.name);
  const copy = names.map(name => columns.find(column => column.name === name)?.pk === 1 ? `substr(${name}, 1, length(${name}) - 1) || 'z'` : name);
  return [
    ...text.map(column => `UPDATE ${table} SET ${column} = ${column} || 'x' WHERE ${target}`),
    `DELETE FROM ${table} WHERE ${target}`,
    `INSERT INTO ${table}(${names.join(', ')}) SELECT ${copy.join(', ')} FROM ${table} WHERE ${target}`,
  ];
}

export function sqliteBatch(database: DatabaseSync): Batch {
  return async statements => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => database.prepare(statement.sql).all(...statement.params).map(row => ({ ...row })));
      database.exec('COMMIT');
      return results;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };
}
