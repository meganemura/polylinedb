// Exercises comment edits on real local stores; test/comment-edit-d1.integration.ts runs the same flows on workerd D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as hegel from '@hegeldev/hegel';
import * as gs from '@hegeldev/hegel/generators';
import { node } from 'solarsql/node';
import { initializeStore, openStore, upgradeStore } from '../src/local-store/index.ts';
import { executeOperation, parseOperation } from '../src/records/index.ts';
import { SCHEMA_SQL, SCHEMA_V9_SQL, canonicalSnapshot, convertSnapshotV7, parseSnapshot } from '../src/records/persistence/persistence.ts';
import type { SqlExecutor } from '../src/records/persistence/persistence.ts';
import { PolylinedbError } from '../src/records/store/errors.ts';
import { checkSchema9Upgrade, populateSchema9, readEvents, runCommentEditFlow } from './fixtures/comment-edit-flow.ts';
import { runChangeFeedFlow } from './fixtures/change-feed-flow.ts';

const propertyCases = Number(process.env.PD_HEGEL_CASES ?? 100);
assert.ok(Number.isSafeInteger(propertyCases) && propertyCases > 0);

function root(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'pd-comment-edit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function executor(db: DatabaseSync): SqlExecutor {
  return { reads: node(db), async batch(statements) {
    db.exec('BEGIN IMMEDIATE');
    try { const rows = statements.map(statement => ({ rows: db.prepare(statement.sql).all(...statement.params) })); db.exec('COMMIT'); return rows; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
}

test('an author edits a comment once per observed version, and every refusal leaves the comment and the feed as they were', async t => {
  const directory = join(root(t), 'store'); initializeStore({ directory });
  const store = openStore({ directory }); t.after(() => store.close());
  await runCommentEditFlow(store.db);
});

async function schema9Store(base: string, name: string, populate?: (db: SqlExecutor) => Promise<void>): Promise<{ directory: string }> {
  const directory = join(base, name); mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, 'polylinedb.sqlite');
  const legacy = new DatabaseSync(path); legacy.exec(SCHEMA_V9_SQL);
  try { await populate?.(executor(legacy)); } finally { legacy.close(); }
  chmodSync(path, 0o600);
  const outcome = upgradeStore({ directory }); assert.deepEqual([outcome.result, outcome.version], ['upgraded', 12]);
  const upgraded = new DatabaseSync(path); const reference = new DatabaseSync(':memory:'); reference.exec(SCHEMA_SQL);
  const schema = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
  try { assert.deepEqual(upgraded.prepare(schema).all(), reference.prepare(schema).all()); } finally { upgraded.close(); reference.close(); }
  return { directory };
}

test('a populated schema 9 store upgrades to schema 12 with every event at its seq, and later writes continue the feed', async t => {
  let populated: Awaited<ReturnType<typeof populateSchema9>> | undefined; let before: Awaited<ReturnType<typeof readEvents>> = [];
  const { directory } = await schema9Store(root(t), 'populated', async db => { populated = await populateSchema9(db); before = await readEvents(db); });
  const store = openStore({ directory }); t.after(() => store.close());
  assert.ok(populated);
  await checkSchema9Upgrade(store.db, populated, before);
});

test('every change feed trigger records its events on a store that upgraded from schema 9', async t => {
  const { directory } = await schema9Store(root(t), 'empty');
  const store = openStore({ directory }); t.after(() => store.close());
  assert.equal((await runChangeFeedFlow(store.db)).length, 66);
});

test('snapshot 7 converts to snapshot 9 with each comment at version 1 and no editor', async t => {
  const directory = join(root(t), 'store'); initializeStore({ directory });
  const store = openStore({ directory }); t.after(() => store.close());
  const created = await executeOperation(store.db, parseOperation({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'convert', body: 'Convert' }), 'alice');
  assert.ok('issue' in created);
  await executeOperation(store.db, parseOperation({ op: 'comment', id: created.issue.id, body: 'kept' }), 'alice');
  const { stars: _stars, issue_items: _items, ...current } = store.exportSnapshot();
  const v7 = { ...current, version: 7, comments: current.comments.map(({ version: _v, updated_at: _a, updated_by: _b, handle: _h, via: _via, reply_to: _r, ...comment }) => comment) };
  const converted = convertSnapshotV7(v7);
  assert.equal(converted.version, 10);
  assert.equal(canonicalSnapshot(converted), canonicalSnapshot(store.exportSnapshot()));
  assert.throws(() => parseSnapshot(v7), { code: 'invalid_snapshot' });
  assert.throws(() => convertSnapshotV7({ ...v7, comments: current.comments }), { code: 'invalid_snapshot' });
});

test('property: an edit is accepted exactly when its expected version is the current one, and the body is the last accepted body', async () => {
  let casesRun = 0;
  await hegel.testAsync(async tc => {
    casesRun += 1;
    const directory = mkdtempSync(join(tmpdir(), 'pd-comment-edit-property-'));
    try {
      initializeStore({ directory: join(directory, 'store') });
      const store = openStore({ directory: join(directory, 'store') });
      try {
        const created = await executeOperation(store.db, parseOperation({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'hegel', project: 'edits', body: 'Edits' }), 'alice');
        assert.ok('issue' in created);
        const written = await executeOperation(store.db, parseOperation({ op: 'comment', id: created.issue.id, body: 'start' }), 'alice');
        assert.ok('comment' in written);
        const edits = tc.draw(gs.arrays(gs.record({ expected: gs.integers({ minValue: 1, maxValue: 6 }), body: gs.text({ minSize: 1, maxSize: 12, excludeCharacters: '\u0000' }).filter(text => text.trim().length > 0) }), { minSize: 1, maxSize: 10 }));
        let version = 1; let body = 'start';
        for (const edit of edits) {
          const accepted = edit.expected === version;
          try {
            const result = await executeOperation(store.db, parseOperation({ op: 'comment_edit', id: created.issue.id, comment_id: written.comment.id, body: edit.body, expected: edit.expected }), 'alice');
            assert.ok(accepted, `expected ${edit.expected} at version ${version} was accepted`);
            assert.ok('comment' in result);
            version += 1; body = edit.body;
            assert.deepEqual([result.comment.version, result.comment.body], [version, body]);
          } catch (error) {
            if (!(error instanceof PolylinedbError)) throw error;
            assert.equal(accepted, false, `expected ${edit.expected} at version ${version} was refused`);
            assert.equal(error.code, 'comment_conflict');
          }
        }
        const shown = await executeOperation(store.db, parseOperation({ op: 'show', id: created.issue.id }), 'alice');
        assert.ok('comments' in shown);
        assert.deepEqual(shown.comments.map(comment => [comment.version, comment.body]), [[version, body]]);
        const recorded = await executeOperation(store.db, parseOperation({ op: 'changes', since: 0, kinds: ['comment_edited'], limit: 100 }), 'alice');
        assert.ok('next_since' in recorded);
        assert.equal(recorded.changes.length, version - 1);
      } finally { store.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, { testCases: propertyCases, seed: 20261019, database: hegel.Database.fromPath('.hegel') });
  assert.ok(casesRun > 0);
});
