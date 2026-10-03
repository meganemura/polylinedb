// Exercises observable issue behavior with real SQLite connections and parallel writers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { PolylinedbError, executeOperation, parseOperation } from '../src/issues.ts';
import type { Issue, SqlExecutor } from '../src/issues.ts';
import { initializeStore, openStore } from '../src/sqlite.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'polylinedb-issues-'));
  const directory = join(root, 'store');
  const cwd = join(root, 'work');
  initializeStore({ directory, cwd });
  const first = openStore({ directory, cwd });
  const second = openStore({ directory, cwd });
  t.after(() => { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, directory, cwd, first: first.db, second: second.db };
}
const execute = (db: SqlExecutor, operation: unknown, actor = 'tester') => executeOperation(db, parseOperation(operation), actor);
async function create(db: SqlExecutor, extra: Record<string, unknown> = {}): Promise<Issue> {
  const result = await execute(db, { op: 'create', tool: 'compiler', project: 'parser', body: 'Empty input fails', ...extra });
  assert.ok('issue' in result);
  return result.issue;
}
async function show(db: SqlExecutor, id: string): Promise<Issue> {
  const result = await execute(db, { op: 'show', id });
  assert.ok('issue' in result);
  return result.issue;
}
function errorCode(code: string) {
  return (error: unknown) => error instanceof PolylinedbError && error.code === code;
}

test('same-field stale writes fail while independent fields preserve both edits', async (t) => {
  const { first, second } = fixture(t);
  const issue = await create(first);
  assert.deepEqual(issue.versions, { tool: 1, project: 1, body: 1, status: 1, type: 1, priority: 1, labels: 1 });
  await execute(first, { op: 'update', id: issue.id, changes: [{ field: 'body', value: 'First edit', expected: 1 }] }, 'first');
  await assert.rejects(execute(second, { op: 'update', id: issue.id, changes: [{ field: 'body', value: 'Lost edit', expected: 1 }] }), (error: unknown) => {
    assert.ok(error instanceof PolylinedbError);
    assert.equal(error.code, 'conflict');
    assert.equal(error.status, 409);
    assert.deepEqual(error.details, { issue: { ...issue, body: 'First edit', versions: { ...issue.versions, body: 2 }, updated_by: 'first', updated_at: (error.details as {issue:Issue}).issue.updated_at },
      fields: [{ field: 'body', expected: 1, actual: 2, current: 'First edit' }] });
    return true;
  });
  await execute(second, { op: 'update', id: issue.id, changes: [{ field: 'priority', value: 0, expected: 1 }] }, 'second');
  const observed = await show(first, issue.id);
  assert.equal(observed.body, 'First edit');
  assert.equal(observed.priority, 0);
  assert.equal(observed.versions.body, 2);
  assert.equal(observed.versions.priority, 2);
  assert.equal(observed.updated_by, 'second');
});

test('multi-field conflicts are atomic and ABA plus same-value edits advance versions', async (t) => {
  const { first, second } = fixture(t);
  const issue = await create(first, { body: 'A' });
  await execute(first, { op: 'update', id: issue.id, changes: [{ field: 'body', value: 'B', expected: 1 }] });
  await assert.rejects(execute(second, { op: 'update', id: issue.id, changes: [
    { field: 'priority', value: 0, expected: 1 }, { field: 'body', value: 'C', expected: 1 },
  ] }), errorCode('conflict'));
  assert.equal((await show(first, issue.id)).priority, 2);
  await execute(first, { op: 'update', id: issue.id, changes: [{ field: 'body', value: 'A', expected: 2 }] });
  await assert.rejects(execute(second, { op: 'update', id: issue.id, changes: [{ field: 'body', value: 'D', expected: 1 }] }), errorCode('conflict'));
  await execute(first, { op: 'update', id: issue.id, changes: [{ field: 'body', value: 'A', expected: 3 }] });
  assert.equal((await show(first, issue.id)).versions.body, 4);
  await assert.rejects(execute(second, { op: 'update', id: issue.id, changes: [{ field: 'body', value: 'E', expected: 3 }] }), errorCode('conflict'));
});

test('labels form one canonical field and status convenience operations use CAS', async (t) => {
  const { first, second } = fixture(t);
  const issue = await create(first, { labels: ['z', 'a', 'z'] });
  assert.deepEqual(issue.labels, ['a', 'z']);
  await execute(first, { op: 'update', id: issue.id, changes: [{ field: 'labels', value: ['b', 'a'], expected: 1 }] });
  await assert.rejects(execute(second, { op: 'update', id: issue.id, changes: [{ field: 'labels', value: ['c'], expected: 1 }] }), errorCode('conflict'));
  await execute(first, { op: 'close', id: issue.id, expected: 1 });
  await assert.rejects(execute(second, { op: 'reopen', id: issue.id, expected: 1 }), errorCode('conflict'));
  await execute(second, { op: 'reopen', id: issue.id, expected: 2 });
  const observed = await show(first, issue.id);
  assert.equal(observed.status, 'open');
  assert.equal(observed.versions.status, 3);
  assert.deepEqual(observed.labels, ['a', 'b']);
});

test('comments append independently and search matches literal body or comment substrings', async (t) => {
  const { first, second } = fixture(t);
  const issue = await create(first);
  await Promise.all([
    execute(first, { op: 'comment', id: issue.id, body: 'contains %_ literal' }, 'one'),
    execute(second, { op: 'comment', id: issue.id, body: 'Second reproduction' }, 'two'),
  ]);
  const shown = await execute(first, { op: 'show', id: issue.id });
  assert.ok('comments' in shown);
  assert.deepEqual(shown.comments.map((comment) => comment.body).sort(), ['Second reproduction', 'contains %_ literal']);
  assert.deepEqual(shown.comments.map((comment) => comment.created_by).sort(), ['one', 'two']);
  assert.deepEqual(shown.issue.versions, issue.versions);
  assert.equal(shown.issue.updated_at, issue.updated_at);
  const found = await execute(first, { op: 'search', query: '%_' });
  assert.ok('issues' in found);
  assert.deepEqual(found.issues.map((candidate) => candidate.id), [issue.id]);
  const absent = await execute(first, { op: 'search', query: 'empty input' });
  assert.ok('issues' in absent);
  assert.deepEqual(absent.issues, []);
  const body = await execute(first, { op: 'search', query: 'Empty input' });
  assert.ok('issues' in body);
  assert.equal(body.issues[0]?.id, issue.id);
});

test('list combines filters and cursor pagination without duplicate issues', async (t) => {
  const { first } = fixture(t);
  const a = await create(first, { labels: ['selected'], priority: 1, type: 'bug' });
  const b = await create(first, { labels: ['selected'], priority: 1, type: 'bug' });
  await create(first, { labels: ['other'], priority: 1, type: 'bug' });
  await create(first, { labels: ['selected'], priority: 2, type: 'bug' });
  const filters = { op: 'list', tool: 'compiler', project: 'parser', status: 'open', type: 'bug', priority: 1, label: 'selected', limit: 1 };
  const page = await execute(first, filters);
  assert.ok('issues' in page);
  const expected = [a.id, b.id].sort();
  assert.equal(page.issues[0]?.id, expected[0]);
  assert.equal(page.next_cursor, expected[0]);
  const next = await execute(first, { ...filters, after: page.next_cursor });
  assert.ok('issues' in next);
  assert.equal(next.issues[0]?.id, expected[1]);
  assert.equal(next.next_cursor, null);
});

test('epic containment checks are atomic and parent status does not cascade', async (t) => {
  const { first, second } = fixture(t);
  const epic = await create(first, { type: 'epic' });
  const child = await create(second, { parent: epic.id, project: 'other' });
  assert.equal(child.id.slice(0, epic.id.length + 1), `${epic.id}.`);
  assert.equal('parent_id' in child, false);
  await assert.rejects(execute(first, { op: 'update', id: epic.id, changes: [{ field: 'type', value: 'task', expected: 1 }, { field: 'body', value: 'should roll back', expected: 1 }] }), errorCode('epic_has_children'));
  assert.equal((await show(first, epic.id)).body, 'Empty input fails');
  await execute(first, { op: 'close', id: epic.id, expected: 1 });
  assert.equal((await show(second, child.id)).status, 'open');
  const demoted = await create(first, { type: 'epic' });
  await execute(first, { op: 'update', id: demoted.id, changes: [{ field: 'type', value: 'task', expected: 1 }] });
  await assert.rejects(create(second, { parent: demoted.id }), errorCode('invalid_input'));
});

test('invalid input rejects unknown fields, invalid versions and duplicate edits', async (t) => {
  const { first } = fixture(t);
  const issue = await create(first);
  for (const operation of [
    { op: 'show', id: issue.id, surprise: true },
    { op: 'create', tool: 'x', project: 'y', body: 'z', id: issue.id },
    { op: 'create', tool: 'x\ny', project: 'y', body: 'z' },
    { op: 'create', tool: 'x', project: 'y', body: 'あ'.repeat(22000) },
    { op: 'update', id: issue.id, changes: [] },
    { op: 'update', id: issue.id, changes: [{ field: 'title', value: 'x', expected: 1 }] },
    { op: 'update', id: issue.id, changes: [{ field: 'body', value: 'x', expected: 0 }] },
    { op: 'update', id: issue.id, changes: [{ field: 'body', value: 'x', expected: 1 }, { field: 'body', value: 'y', expected: 1 }] },
    { op: 'list', limit: 101 }, { op: 'list', priority: 1.5 },
    { op: 'show', id: 'not-an-id' },
  ]) assert.throws(() => parseOperation(operation), errorCode('invalid_input'));
  await assert.rejects(execute(first, { op: 'comment', id: issue.id, body: 'valid' }, 'bad\nactor'), errorCode('invalid_input'));
  await assert.rejects(execute(first, { op: 'show', id: crypto.randomUUID() }), errorCode('not_found'));
  assert.deepEqual(await execute(first, { op: 'actor' }, 'local:alice'), { actor: 'local:alice' });
});

test('version exhaustion changes none of the requested fields', async (t) => {
  const { first } = fixture(t);
  const issue = await create(first);
  await first.batch([{ sql: 'UPDATE issues SET body_v = ? WHERE id = ?', params: [Number.MAX_SAFE_INTEGER, issue.id] }]);
  await assert.rejects(execute(first, { op: 'update', id: issue.id, changes: [
    { field: 'priority', value: 0, expected: 1 }, { field: 'body', value: 'overflow', expected: Number.MAX_SAFE_INTEGER },
  ] }), errorCode('version_exhausted'));
  const observed = await show(first, issue.id);
  assert.equal(observed.priority, 2);
  assert.equal(observed.versions.priority, 1);
  assert.equal(observed.body, 'Empty input fails');
  assert.equal(observed.versions.body, Number.MAX_SAFE_INTEGER);
});

async function parallel(directory: string, cwd: string, operations: unknown[]) {
  const gate = new SharedArrayBuffer(4);
  const signal = new Int32Array(gate);
  const workers = operations.map((operation) => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { openStore } = await import(workerData.sqlite);
      const { executeOperation, parseOperation } = await import(workerData.issues);
      const store = openStore({directory: workerData.directory, cwd: workerData.cwd});
      parentPort.postMessage({ready: true});
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      try { parentPort.postMessage({result: await executeOperation(store.db, parseOperation(workerData.operation), 'parallel')}); }
      catch (error) { parentPort.postMessage({error: error.code ?? error.message}); }
      finally { store.close(); }
    })().catch(error => { throw error; });
  `, { eval: true, workerData: { operation, directory, cwd, gate,
    sqlite: new URL('../src/sqlite.ts', import.meta.url).href, issues: new URL('../src/issues.ts', import.meta.url).href } }));
  try {
    const results = workers.map((worker) => new Promise<{ error?: string; result?: unknown }>((resolve, reject) => {
      worker.on('error', reject);
      worker.on('message', (message) => { if (!message.ready) resolve(message); });
    }));
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      worker.on('error', reject);
      worker.on('message', (message) => { if (message.ready) resolve(); });
    })));
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
    return await Promise.all(results);
  } finally { await Promise.all(workers.map((worker) => worker.terminate())); }
}

test('parallel SQLite connections elect one same-field winner and allow different fields', async (t) => {
  const { first, directory, cwd } = fixture(t);
  const issue = await create(first);
  const results = await parallel(directory, cwd, ['one', 'two'].map((value) => ({ op: 'update', id: issue.id, changes: [{ field: 'body', value, expected: 1 }] })));
  assert.equal(results.filter((result) => result.result).length, 1);
  assert.deepEqual(results.filter((result) => result.error).map((result) => result.error), ['conflict']);
  const both = await parallel(directory, cwd, [
    { op: 'update', id: issue.id, changes: [{ field: 'priority', value: 0, expected: 1 }] },
    { op: 'update', id: issue.id, changes: [{ field: 'status', value: 'in_progress', expected: 1 }] },
  ]);
  assert.equal(both.filter((result) => result.result).length, 2);
  const observed = await show(first, issue.id);
  assert.equal(observed.priority, 0);
  assert.equal(observed.status, 'in_progress');
});

test('parallel child creation and epic demotion preserve containment', async (t) => {
  const { first, directory, cwd } = fixture(t);
  const epic = await create(first, { type: 'epic' });
  const results = await parallel(directory, cwd, [
    { op: 'create', parent: epic.id, tool: 'compiler', project: 'parser', body: 'child' },
    { op: 'update', id: epic.id, changes: [{ field: 'type', value: 'task', expected: 1 }] },
  ]);
  assert.equal(results.filter((result) => result.result).length, 1);
  const parent = await show(first, epic.id);
  const listed = await execute(first, { op: 'list' });
  assert.ok('issues' in listed);
  const children = listed.issues.filter((issue) => issue.id.startsWith(`${epic.id}.`));
  if (parent.type === 'epic') {
    assert.equal(children.length, 1);
    assert.equal(results[1]?.error, 'epic_has_children');
  } else {
    assert.equal(parent.type, 'task');
    assert.equal(children.length, 0);
    assert.equal(results[0]?.error, 'invalid_input');
  }
});
