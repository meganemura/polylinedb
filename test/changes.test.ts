// Exercises the change feed on real local stores; test/changes-d1.integration.ts runs the same flow on workerd D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initializeStore, openStore, upgradeStore } from '../src/local-store/index.ts';
import { executeOperation, parseOperation } from '../src/records/index.ts';
import { SCHEMA_SQL } from '../src/records/persistence.ts';
import type { SqlExecutor } from '../src/records/persistence.ts';
import { runChangeFeedFlow } from './fixtures/change-feed-flow.ts';
import { downgradeToSchema6, withoutChangeWriter } from './fixtures/legacy-schema.ts';

function location(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pd-changes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const place = { directory: join(root, 'store'), cwd: join(root, 'work') };
  return { place, database_path: initializeStore(place).database_path };
}
const changes = async (db: SqlExecutor, since = 0, incarnation?: string) => {
  const result = await executeOperation(db, parseOperation({ op: 'changes', since, ...(incarnation ? { incarnation } : {}) }), 'reader');
  assert.ok('next_since' in result);
  return result;
};
const created = (project = 'feed') => parseOperation({ op: 'create', prefix: 'cf', request_id: crypto.randomUUID(), tool: 'feed', project, body: 'issue' });

test('change feed records the shared flow on a local SQLite store', async t => {
  const store = openStore(location(t).place);
  try { assert.equal((await runChangeFeedFlow(store.db)).length, 63); }
  finally { store.close(); }
});

test('change feed records nothing for snapshot import or memory writes, and the import starts a new incarnation', async t => {
  const source = openStore(location(t).place);
  const target = openStore(location(t).place);
  try {
    await executeOperation(source.db, created(), 'alice');
    await executeOperation(source.db, parseOperation({ op: 'comment', id: 'cf-1', body: 'before export' }), 'alice');
    const before = await changes(target.db);
    assert.equal(target.importSnapshot(source.exportSnapshot()).result, 'imported');
    const imported = await changes(target.db);
    assert.notEqual(imported.incarnation, before.incarnation);
    assert.deepEqual(imported, { incarnation: imported.incarnation, changes: [], next_since: 0 });
    await executeOperation(target.db, parseOperation({ op: 'memory_create', project: 'feed', prefix: 'cf', request_id: crypto.randomUUID(), title: 'Build', body: 'Run npm test.' }), 'alice');
    assert.deepEqual((await changes(target.db)).changes, []);
    await executeOperation(target.db, parseOperation({ op: 'comment', id: 'cf-1', body: 'after import' }), 'bob');
    assert.deepEqual((await changes(target.db)).changes.map(({ seq, issue_id, kind, actor }) => ({ seq, issue_id, kind, actor })), [{ seq: 1, issue_id: 'cf-1', kind: 'commented', actor: 'bob' }]);
  } finally { source.close(); target.close(); }
});

test('upgrading a schema 6 store adds the canonical change feed DDL, and writes of an earlier release still commit without events', async t => {
  const { place, database_path } = location(t);
  const store = openStore(place);
  try { await executeOperation(store.db, created(), 'alice'); } finally { store.close(); }
  const legacy = new DatabaseSync(database_path); downgradeToSchema6(legacy); legacy.close();
  assert.deepEqual(upgradeStore(place), { result: 'upgraded', version: 7, database_path });
  const schema = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
  const upgraded = new DatabaseSync(database_path, { readOnly: true }); const fresh = new DatabaseSync(':memory:'); fresh.exec(SCHEMA_SQL);
  try { assert.deepEqual(upgraded.prepare(schema).all(), fresh.prepare(schema).all()); } finally { upgraded.close(); fresh.close(); }
  const reopened = openStore(place);
  try {
    assert.deepEqual((await changes(reopened.db)).changes, []);
    await executeOperation(reopened.db, parseOperation({ op: 'update', id: 'cf-1', changes: [{ field: 'body', value: 'edited', expected: 1 }] }), 'alice');
    assert.deepEqual((await changes(reopened.db)).changes.map(({ seq, kind, fields }) => ({ seq, kind, fields })), [{ seq: 1, kind: 'updated', fields: ['body'] }]);
    const earlierRelease = withoutChangeWriter(reopened.db);
    await executeOperation(earlierRelease, created(), 'alice');
    await executeOperation(earlierRelease, parseOperation({ op: 'comment', id: 'cf-1', body: 'from a schema 6 Worker' }), 'alice');
    await executeOperation(earlierRelease, parseOperation({ op: 'close', id: 'cf-1', expected: 1 }), 'alice');
    assert.equal((await changes(reopened.db)).next_since, 1);
  } finally { reopened.close(); }
});

test('changes input requires a cursor, a valid incarnation, and known filters', () => {
  const incarnation = 'a'.repeat(32);
  assert.deepEqual(parseOperation({ op: 'changes', since: 0 }), { op: 'changes', since: 0, limit: 50 });
  assert.deepEqual(parseOperation({ op: 'changes', since: 4, incarnation, project: 'feed', issue_ids: ['cf-2', 'cf-1.1'], kinds: ['became_ready'], limit: 100 }),
    { op: 'changes', since: 4, incarnation, project: 'feed', issue_ids: ['cf-2', 'cf-1.1'], kinds: ['became_ready'], limit: 100 });
  for (const [input, message] of [
    [{}, /since/],
    [{ since: -1 }, /since/],
    [{ since: 1.5 }, /since/],
    [{ since: Number.MAX_SAFE_INTEGER + 1 }, /since/],
    [{ since: 1 }, /incarnation is required/],
    [{ since: 1, incarnation: 'A'.repeat(32) }, /incarnation/i],
    [{ since: 0, limit: 0 }, /limit/],
    [{ since: 0, limit: 101 }, /limit/],
    [{ since: 0, kinds: [] }, /kinds/],
    [{ since: 0, kinds: ['reclaimed'] }, /kinds entries/],
    [{ since: 0, kinds: ['created', 'created'] }, /must not repeat/],
    [{ since: 0, issue_ids: ['cf-1', 'cf-1'] }, /must not repeat/],
    [{ since: 0, issue_ids: ['CF-1'] }, /Invalid id/],
    [{ since: 0, issue_ids: Array.from({ length: 51 }, (_, index) => `cf-${index + 1}`) }, /issue_ids/],
    [{ since: 0, project: ' ' }, /project/i],
    [{ since: 0, cursor: 'x' }, /cursor/],
  ] satisfies [Record<string, unknown>, RegExp][]) assert.throws(() => parseOperation({ op: 'changes', ...input }), { code: 'invalid_input', message }, JSON.stringify(input));
});
