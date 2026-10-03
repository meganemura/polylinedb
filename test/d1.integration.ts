/** Checks the shared store against local workerd D1. It does not validate a production account. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { d1Executor } from '../src/d1.ts';
import { executeOperation, parseOperation } from '../src/issues.ts';
import { SCHEMA_SQL } from '../src/schema.ts';

const modulePath = process.argv[2];
const { Miniflare } = await import(modulePath ? pathToFileURL(modulePath).href : 'miniflare');
const runtime = new Miniflare({
  workers: [{ config: {
    name: 'polylinedb-test', compatibilityDate: '2026-09-25',
    manifest: { mainModule: 'index.js', modules: {
      'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response("ready"); } }' },
    } },
    env: { DB: { type: 'd1', name: 'polylinedb-test' } },
  } }],
});

try {
  const database = await runtime.getD1Database('DB');
  await database.batch(SCHEMA_SQL.split(';').map((sql) => sql.trim()).filter(Boolean).map((sql) => database.prepare(sql)));
  const db = d1Executor(database);
  const run = (operation: unknown) => executeOperation(db, parseOperation(operation), 'test:d1');
  const created = await run({ op: 'create', tool: 'compiler', project: 'parser', body: 'D1 persistence' });
  assert('issue' in created);
  assert.equal(created.issue.body, 'D1 persistence');
  const id = created.issue.id;
  const outcomes = await Promise.allSettled([
    run({ op: 'update', id, changes: [{ field: 'body', expected: 1, value: 'first' }] }),
    run({ op: 'update', id, changes: [{ field: 'body', expected: 1, value: 'second' }] }),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  const loser = outcomes.find((result) => result.status === 'rejected');
  assert(loser?.status === 'rejected');
  assert.equal(loser.reason.code, 'conflict');
  await run({ op: 'update', id, changes: [{ field: 'priority', expected: 1, value: 0 }] });
  await assert.rejects(run({ op: 'update', id, changes: [
    { field: 'status', expected: 1, value: 'closed' }, { field: 'body', expected: 1, value: 'stale' },
  ] }), { code: 'conflict' });
  const shown = await run({ op: 'show', id });
  assert('issue' in shown);
  assert.equal(shown.issue.status, 'open');
  assert.equal(shown.issue.priority, 0);
  assert.equal(shown.issue.versions.body, 2);
  await assert.rejects(database.batch([
    database.prepare("UPDATE issues SET body = 'must roll back' WHERE id = ?").bind(id),
    database.prepare('INSERT INTO absent_table VALUES (1)'),
  ]));
  const afterRollback = await run({ op: 'show', id });
  assert('issue' in afterRollback);
  assert.equal(afterRollback.issue.body, shown.issue.body);
  await Promise.all([run({ op: 'comment', id, body: 'alpha' }), run({ op: 'comment', id, body: 'beta' })]);
  const comments = await run({ op: 'show', id });
  assert('comments' in comments);
  assert.deepEqual(comments.comments.map((comment) => comment.body).sort(), ['alpha', 'beta']);
  process.stdout.write('PASS: local workerd D1 persistence, field CAS, unrelated edits, atomic conflict, rollback, and comments\n');
} finally { await runtime.dispose(); }
