/** Checks the shared store against local workerd D1. It does not validate a production account. */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { d1Executor } from '../src/d1.ts';
import { executeOperation, parseOperation } from '../src/operations.ts';
import { SCHEMA_STATEMENTS } from '../src/schema.ts';

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
  await database.batch(SCHEMA_STATEMENTS.map(sql => database.prepare(sql)));
  const db = d1Executor(database);
  const run = (operation: unknown) => executeOperation(db, parseOperation(operation), 'test:d1');
  const memoryRequest = { op: 'memory_create', project: 'parser', prefix: 'pd', request_id: crypto.randomUUID(), title: 'D1 fact', body: 'Shared memory contract' };
  const memory = await run(memoryRequest); assert('memory' in memory); assert.equal(memory.memory.id, 'pd-m1');
  assert.deepEqual(await run(memoryRequest), memory);
  const memoryWriters = await Promise.allSettled([
    run({ op: 'memory_update', project: 'parser', id: 'pd-m1', title: 'D1 fact', body: 'First', expected: 1 }),
    run({ op: 'memory_update', project: 'parser', id: 'pd-m1', title: 'D1 fact', body: 'Second', expected: 1 }),
  ]);
  assert.equal(memoryWriters.filter(result => result.status === 'fulfilled').length, 1);
  const memoryLoser = memoryWriters.find(result => result.status === 'rejected');
  assert(memoryLoser?.status === 'rejected'); assert.equal(memoryLoser.reason.code, 'memory_conflict');
  await run({ op: 'memory_delete', project: 'parser', id: 'pd-m1', expected: 2 });
  await assert.rejects(run(memoryRequest), { code: 'memory_deleted' });
  const created = await run({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'compiler', project: 'parser', body: 'D1 persistence' });
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
  const largeBody = 'x'.repeat(64000);
  for (let i = 0; i < 34; i++) await run({ op: 'comment', id, body: largeBody });
  const largeThread = await run({ op: 'show', id });
  assert('comments' in largeThread);
  assert.equal(largeThread.comments.length, 36);
  assert.equal(largeThread.comments.filter(comment => comment.body === largeBody).length, 34);
  await run({ op: 'update', id, changes: [{ field: 'labels', value: ['exact', 'quote"slash\\'], expected: 1 }] });
  const filtered = await run({ op: 'search', query: 'alpha', label: 'quote"slash\\', priority: 0 });
  assert('issues' in filtered);
  assert.deepEqual(filtered.issues.map(issue => issue.id), [id]);
  const request = { op: 'create', prefix: 'seq', request_id: crypto.randomUUID(), tool: 't', project: 'p', body: 'retry', type: 'epic' };
  const duplicates = await Promise.all([run(request), run(request), run(request)]);
  assert.deepEqual(duplicates[0], duplicates[1]); assert.deepEqual(duplicates[1], duplicates[2]);
  assert('issue' in duplicates[0]); assert.equal(duplicates[0].issue.id, 'seq-1');
  await run({ op: 'update', id: 'seq-1', changes: [{ field: 'body', expected: 1, value: 'edited' }] });
  const replay = await run(request); assert('issue' in replay); assert.equal(replay.issue.body, 'edited');
  await assert.rejects(run({ ...request, body: 'different' }), { code: 'request_conflict', status: 409 });
  await assert.rejects(executeOperation(db, parseOperation(request), 'other'), { code: 'request_conflict', status: 409 });
  const distinct = await Promise.all(Array.from({ length: 4 }, () => run({ ...request, request_id: crypto.randomUUID() })));
  assert.deepEqual(distinct.map(value => { assert('issue' in value); return value.issue.id; }).sort(), ['seq-2', 'seq-3', 'seq-4', 'seq-5']);
  await database.batch([
    database.prepare('INSERT INTO counters(scope,last_number) VALUES (?,?)').bind('seq-1', 98),
    database.prepare('UPDATE counters SET last_number = 98 WHERE scope = ?').bind('seq'),
  ]);
  for (const parent of [undefined, 'seq-1']) {
    for (const number of [99, 100]) {
      const next = await run({ ...request, request_id: crypto.randomUUID(), ...(parent ? { parent } : {}) });
      assert('issue' in next); assert.equal(next.issue.id, parent ? `${parent}.${number}` : `seq-${number}`);
    }
  }
  const page = await run({ op: 'list', after: 'seq-1', limit: 3 }); assert('issues' in page);
  assert.deepEqual(page.issues.map(issue => issue.id), ['seq-1.99', 'seq-1.100', 'seq-2']);
  const nextPage = await run({ op: 'list', after: page.next_cursor, limit: 10 }); assert('issues' in nextPage);
  assert.deepEqual(nextPage.issues.map(issue => issue.id), ['seq-3', 'seq-4', 'seq-5', 'seq-99', 'seq-100']);
  await database.prepare('INSERT INTO counters(scope,last_number) VALUES (?,?)').bind('full', Number.MAX_SAFE_INTEGER).run();
  await assert.rejects(run({ ...request, prefix: 'full', request_id: crypto.randomUUID() }), { code: 'counter_exhausted', status: 409 });
  process.stdout.write('PASS: local workerd D1 persistence, CAS, rollback, comments, parallel allocation, request replay/conflicts, child numbering, 99→100, natural pagination, and counter exhaustion\n');
} finally { await runtime.dispose(); }
