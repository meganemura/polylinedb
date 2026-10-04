// Exercises observable issue behavior with real SQLite connections and parallel writers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { PolylinedbError, executeOperation, parseOperation } from '../src/issues.ts';
import type { Issue, SqlExecutor } from '../src/issues.ts';
import { initializeStore, openStore } from '../src/sqlite.ts';
import * as hegel from '@hegeldev/hegel';
import * as gs from '@hegeldev/hegel/generators';
import { issueSortKey } from '../src/issue-id.ts';

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
  const result = await execute(db, { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'compiler', project: 'parser', body: 'Empty input fails', ...extra });
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

test('generated label reads preserve exact matching and combined filters', async (t) => {
  const { first } = fixture(t);
  await create(first, { labels: ['a', 'a'], priority: 0, body: 'first' });
  await create(first, { labels: ['aa', 'quote"slash\\'], body: 'second' });
  await create(first, { labels: [], body: 'third' });
  await create(first, { labels: ['a'], status: 'deferred', project: 'other', body: 'fourth' });
  await execute(first, { op: 'comment', id: 'pd-1', body: 'needle\n"quoted"' });
  const list = async (filters: Record<string, unknown>) => {
    const result = await execute(first, { op: 'list', ...filters });
    assert('issues' in result);
    return result.issues.map(issue => issue.id);
  };
  assert.deepEqual(await list({}), ['pd-1', 'pd-2', 'pd-3', 'pd-4']);
  assert.deepEqual(await list({ label: 'a' }), ['pd-1', 'pd-4']);
  assert.deepEqual(await list({ label: 'aa' }), ['pd-2']);
  assert.deepEqual(await list({ label: 'quote"slash\\' }), ['pd-2']);
  assert.deepEqual(await list({ label: 'absent' }), []);
  assert.deepEqual(await list({ label: 'a', tool: 'compiler', project: 'parser', status: 'open', type: 'task', priority: 0 }), ['pd-1']);
  assert.deepEqual(await list({ label: 'a', after: 'pd-1', limit: 1 }), ['pd-4']);
  const search = await execute(first, { op: 'search', query: 'needle\n"quoted"', label: 'a', priority: 0 });
  assert('issues' in search);
  assert.deepEqual(search.issues.map(issue => issue.id), ['pd-1']);
});

test('generated show preserves empty comments and timestamp/ID ordering without coercing corrupt values', async (t) => {
  const { first } = fixture(t);
  await create(first);
  const empty = await execute(first, { op: 'show', id: 'pd-1' });
  assert('comments' in empty);
  assert.deepEqual(empty.comments, []);
  const earlier = '2026-01-01T00:00:00.000Z';
  const later = '2026-01-02T00:00:00.000Z';
  for (const [suffix, date, body] of [['3', later, 'last'], ['2', earlier, 'second'], ['1', earlier, 'first\n"quoted"']]) {
    await first.batch([{ sql: 'INSERT INTO comments VALUES (?, ?, ?, ?, ?)',
      params: [`00000000-0000-4000-8000-00000000000${suffix}`, 'pd-1', body, date, 'tester'] }]);
  }
  const shown = await execute(first, { op: 'show', id: 'pd-1' });
  assert('comments' in shown);
  assert.deepEqual(shown.comments.map(comment => comment.body), ['first\n"quoted"', 'second', 'last']);
  await first.batch([{ sql: "UPDATE comments SET body = X'6162' WHERE body = 'last'", params: [] }]);
  await assert.rejects(execute(first, { op: 'show', id: 'pd-1' }), errorCode('invalid_store'));
});

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
  const retainedEpic = await execute(first, { op: 'update', id: epic.id, changes: [{ field: 'type', value: 'epic', expected: 1 }] });
  assert.ok('issue' in retainedEpic);
  assert.equal(retainedEpic.issue.versions.type, 2);
  await assert.rejects(execute(first, { op: 'update', id: epic.id, changes: [{ field: 'type', value: 'task', expected: 2 }, { field: 'body', value: 'should roll back', expected: 1 }] }), errorCode('epic_has_children'));
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
    { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'x', project: 'y', body: 'z', id: issue.id },
    { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'x\ny', project: 'y', body: 'z' },
    { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'x', project: 'y', body: 'あ'.repeat(22000) },
    { op: 'update', id: issue.id, changes: [] },
    { op: 'update', id: issue.id, changes: [{ field: 'title', value: 'x', expected: 1 }] },
    { op: 'update', id: issue.id, changes: [{ field: 'body', value: 'x', expected: 0 }] },
    { op: 'update', id: issue.id, changes: [{ field: 'body', value: 'x', expected: 1 }, { field: 'body', value: 'y', expected: 1 }] },
    { op: 'list', limit: 101 }, { op: 'list', priority: 1.5 },
    { op: 'show', id: 'not-an-id' },
  ]) assert.throws(() => parseOperation(operation), errorCode('invalid_input'));
  await assert.rejects(execute(first, { op: 'comment', id: issue.id, body: 'valid' }, 'bad\nactor'), errorCode('invalid_input'));
  await assert.rejects(execute(first, { op: 'show', id: 'pd-999' }), errorCode('not_found'));
  await assert.rejects(execute(first, { op: 'update', id: 'pd-999', changes: [{ field: 'body', value: 'missing', expected: 1 }] }), errorCode('not_found'));
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
    { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), parent: epic.id, tool: 'compiler', project: 'parser', body: 'child' },
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

test('create replay returns current issue and rejects changed payload or actor without allocating', async t => {
  const { first } = fixture(t);
  const request = { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'compiler', project: 'parser', body: 'original', labels: ['b', 'a', 'b'] };
  const created = await execute(first, request);
  assert.ok('issue' in created); assert.equal(created.issue.id, 'pd-1');
  await execute(first, { op: 'update', id: 'pd-1', changes: [{ field: 'project', value: 'moved', expected: 1 }] });
  const replay = await execute(first, { ...request, labels: ['a', 'b'] });
  assert.ok('issue' in replay); assert.equal(replay.issue.project, 'moved');
  assert.equal(replay.issue.versions.project, 2);
  await assert.rejects(execute(first, { ...request, body: 'different' }), { code: 'request_conflict', status: 409 });
  await assert.rejects(execute(first, request, 'other'), { code: 'request_conflict', status: 409 });
  assert.equal((await create(first)).id, 'pd-2');
});

test('parallel creates allocate distinct numbers and concurrent duplicate requests share one issue', async t => {
  const { first, directory, cwd } = fixture(t);
  const request = { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 't', project: 'p', body: 'same' };
  const duplicate = await parallel(directory, cwd, [request, request, request]);
  for (const outcome of duplicate) assert.deepEqual(outcome.result, duplicate[0]?.result);
  assert.equal(duplicate.filter(outcome => outcome.error).length, 0);
  const distinct = await parallel(directory, cwd, Array.from({ length: 4 }, () => ({ ...request, request_id: crypto.randomUUID() })));
  assert.equal(distinct.filter(outcome => outcome.error).length, 0);
  const listed = await execute(first, { op: 'list' });
  assert.ok('issues' in listed); assert.deepEqual(listed.issues.map(issue => issue.id), ['pd-1', 'pd-2', 'pd-3', 'pd-4', 'pd-5']);
  const conflicting = await parallel(directory, cwd, [{ ...request, request_id: crypto.randomUUID(), body: 'one' }].flatMap(item => [item, { ...item, body: 'two' }]));
  assert.equal(conflicting.filter(outcome => outcome.result).length, 1);
  assert.deepEqual(conflicting.filter(outcome => outcome.error).map(outcome => outcome.error), ['request_conflict']);
});

test('root and child counters cross 99 and natural pagination visits every issue once', async t => {
  const { first } = fixture(t);
  await assert.rejects(create(first, { parent: 'pd-999' }), errorCode('not_found'));
  const parent = await create(first, { type: 'epic' });
  for (let number = 1; number <= 101; number++) assert.equal((await create(first, { parent: parent.id })).id, `pd-1.${number}`);
  for (let number = 2; number <= 101; number++) assert.equal((await create(first)).id, `pd-${number}`);
  const expected = ['pd-1', ...Array.from({ length: 101 }, (_, i) => `pd-1.${i + 1}`), ...Array.from({ length: 100 }, (_, i) => `pd-${i + 2}`)];
  const maximumPages = Math.ceil(expected.length / 7);
  const all: string[] = []; const seen = new Set<string>(); let after: string | undefined; let pageCount = 0;
  do {
    pageCount += 1;
    assert.ok(pageCount <= maximumPages, `pagination exceeded ${maximumPages} pages`);
    const page = await execute(first, { op: 'list', limit: 7, ...(after ? { after } : {}) });
    assert.ok('issues' in page);
    for (const issue of page.issues) {
      assert.equal(seen.has(issue.id), false, `pagination repeated ${issue.id}`);
      seen.add(issue.id);
      all.push(issue.id);
    }
    after = page.next_cursor ?? undefined;
  } while (after);
  assert.deepEqual(all, expected);
  assert.equal((await create(first, { prefix: 'other' })).id, 'other-1');
  await assert.rejects(create(first, { parent: parent.id, prefix: 'other' }), { code: 'invalid_input' });
});

test('counter exhaustion and failed create leave counters, requests and issues unchanged', async t => {
  const { first } = fixture(t);
  await first.batch([{ sql: 'INSERT INTO counters(scope,last_number) VALUES (?,?)', params: ['pd', Number.MAX_SAFE_INTEGER] }]);
  await assert.rejects(create(first), { code: 'counter_exhausted', status: 409 });
  const rows = await first.batch([{ sql: 'SELECT * FROM requests', params: [] }, { sql: 'SELECT last_number FROM counters WHERE scope = ?', params: ['pd'] }]);
  assert.deepEqual(rows[0]?.rows, []); assert.equal(rows[1]?.rows[0]?.last_number, Number.MAX_SAFE_INTEGER);
  await first.batch([{ sql: "CREATE TRIGGER refuse_issue BEFORE INSERT ON issues BEGIN SELECT RAISE(ABORT, 'test refusal'); END", params: [] }]);
  await assert.rejects(create(first, { prefix: 'fresh' }), /test refusal/);
  const after = await first.batch([{ sql: 'SELECT * FROM counters WHERE scope = ?', params: ['fresh'] }]);
  assert.deepEqual(after[0]?.rows, []);
});

const propertyCases = Number(process.env.PD_HEGEL_CASES ?? 100);
assert.ok(Number.isSafeInteger(propertyCases) && propertyCases > 0);
const propertyNonblankText = (maxSize: number) => gs.text({ minSize: 1, maxSize, excludeCharacters: "\u0000" })
  .map((value) => value.trim().length === 0 ? "x" : value);

const propertyIssueIdGenerator = gs.composite<string>((tc) => {
  const prefix = tc.draw(gs.sampledFrom(["a", "pd", "team9"] as const));
  const numbers = tc.draw(gs.arrays(gs.integers({ minValue: 1 }), { minSize: 1, maxSize: 8 }));
  return `${prefix}-${numbers.join(".")}`;
});
const issueOrderingBoundaryGenerator = gs.composite<string[]>((tc) => {
  const singleDigit = tc.draw(gs.integers({ minValue: 2, maxValue: 9 }));
  const twoDigit = tc.draw(gs.integers({ minValue: 10, maxValue: 19 }));
  return [`hegel-${singleDigit}`, `hegel-${twoDigit}`];
});

function propertyCompareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function propertyCompareIssueIds(left: string, right: string): number {
  const leftSeparator = left.indexOf("-");
  const rightSeparator = right.indexOf("-");
  const prefixOrder = propertyCompareText(left.slice(0, leftSeparator), right.slice(0, rightSeparator));
  if (prefixOrder !== 0) return prefixOrder;

  const leftNumbers = left.slice(leftSeparator + 1).split(".").map(Number);
  const rightNumbers = right.slice(rightSeparator + 1).split(".").map(Number);
  for (let index = 0; index < Math.min(leftNumbers.length, rightNumbers.length); index += 1) {
    const leftNumber = leftNumbers[index];
    const rightNumber = rightNumbers[index];
    if (leftNumber !== undefined && rightNumber !== undefined && leftNumber !== rightNumber) {
      return leftNumber < rightNumber ? -1 : 1;
    }
  }
  return leftNumbers.length - rightNumbers.length;
}

async function propertyShowIssue(db: SqlExecutor, id: string): Promise<Issue> {
  const result = await executeOperation(db, parseOperation({ op: "show", id }), "hegel-test");
  assert.ok("issue" in result);
  return result.issue;
}

function propertyIsConflict(error: unknown): boolean {
  return error instanceof PolylinedbError && error.code === "conflict";
}

function propertyHasCode(code: string) {
  return (error: unknown): boolean => error instanceof PolylinedbError && error.code === code;
}


test("property: issue sort keys agree with numeric ordering across valid IDs", () => {
  let casesRun = 0;
  hegel.test((tc) => {
    casesRun += 1;
    const ids = [...tc.draw(issueOrderingBoundaryGenerator), ...tc.draw(gs.arrays(propertyIssueIdGenerator, { maxSize: 48, unique: true }))];
    assert.equal(new Set(ids.map(issueSortKey)).size, ids.length);
    const actual = ids.toSorted((left, right) => propertyCompareText(issueSortKey(left), issueSortKey(right)));
    const expected = ids.toSorted(propertyCompareIssueIds);
    assert.deepEqual(actual, expected);
  }, { testCases: propertyCases, seed: 20261004, database: hegel.Database.fromPath(".hegel") });
  assert.equal(casesRun, propertyCases);
});


test("property: issue updates preserve field versions and reject stale writes in generated sequences", async () => {
  let casesRun = 0;
  await hegel.testAsync(async (tc) => {
    casesRun += 1;
    const root = mkdtempSync(join(tmpdir(), "polylinedb-hegel-"));
    const cwd = join(root, "work");
    const directory = join(root, "store");
    mkdirSync(cwd);

    try {
      initializeStore({ directory, cwd });
      const store = openStore({ directory, cwd });
      try {
        const initialBody = tc.draw(propertyNonblankText(16));
        const initialPriority = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
        const created = await executeOperation(store.db, parseOperation({
          op: "create",
          prefix: "pd",
          request_id: "00000000-0000-4000-8000-000000000001",
          tool: "hegel",
          project: "version-property",
          body: initialBody,
          priority: initialPriority,
        }), "hegel-test");
        assert.ok("issue" in created);

        const issueId = created.issue.id;
        const primePriority = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
        const priorityResult = await executeOperation(store.db, parseOperation({
          op: "update",
          id: issueId,
          changes: [{ field: "priority", value: primePriority, expected: 1 }],
        }), "hegel-test");
        assert.ok("issue" in priorityResult);
        assert.equal(priorityResult.issue.priority, primePriority);
        assert.equal(priorityResult.issue.versions.priority, 2);

        const atomicBody = tc.draw(propertyNonblankText(24));
        const atomicPriority = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
        await assert.rejects(executeOperation(store.db, parseOperation({
          op: "update",
          id: issueId,
          changes: [
            { field: "body", value: atomicBody, expected: 1 },
            { field: "priority", value: atomicPriority, expected: 1 },
          ],
        }), "hegel-test"), propertyIsConflict);

        const model = {
          body: initialBody,
          priority: primePriority,
          versions: { body: 1, priority: 2 },
        };
        const afterAtomicConflict = await propertyShowIssue(store.db, issueId);
        assert.equal(afterAtomicConflict.body, model.body);
        assert.equal(afterAtomicConflict.priority, model.priority);
        assert.equal(afterAtomicConflict.versions.body, model.versions.body);
        assert.equal(afterAtomicConflict.versions.priority, model.versions.priority);

        const independentBody = tc.draw(propertyNonblankText(24));
        const independentPriority = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
        const independentResult = await executeOperation(store.db, parseOperation({
          op: "update",
          id: issueId,
          changes: [
            { field: "body", value: independentBody, expected: model.versions.body },
            { field: "priority", value: independentPriority, expected: model.versions.priority },
          ],
        }), "hegel-test");
        model.body = independentBody;
        model.priority = independentPriority;
        model.versions.body += 1;
        model.versions.priority += 1;
        assert.ok("issue" in independentResult);
        assert.equal(independentResult.issue.body, independentBody);
        assert.equal(independentResult.issue.priority, independentPriority);
        assert.deepEqual(independentResult.issue.versions, { ...afterAtomicConflict.versions, body: 2, priority: 3 });
        const afterIndependentUpdate = await propertyShowIssue(store.db, issueId);
        assert.equal(afterIndependentUpdate.body, model.body);
        assert.equal(afterIndependentUpdate.priority, model.priority);
        assert.deepEqual(afterIndependentUpdate.versions, { ...afterAtomicConflict.versions, body: 2, priority: 3 });

        const steps = tc.draw(gs.arrays(gs.record({
          field: gs.sampledFrom(["body", "priority"] as const),
          body: propertyNonblankText(16),
          priority: gs.integers({ minValue: 0, maxValue: 4 }),
          stale: gs.booleans(),
          sameValue: gs.booleans(),
        }), { maxSize: 16 }));

        for (const step of steps) {
          if (step.field === "body") {
            const value = step.sameValue ? model.body : step.body === model.body ? `${step.body}!` : step.body;
            const version = model.versions.body;
            const expected = step.stale && version > 1 ? version - 1 : version;
            const operation = parseOperation({
              op: "update",
              id: issueId,
              changes: [{ field: "body", value, expected }],
            });
            if (expected !== version) {
              await assert.rejects(executeOperation(store.db, operation, "hegel-test"), propertyIsConflict);
            } else {
              await executeOperation(store.db, operation, "hegel-test");
              model.body = value;
              model.versions.body += 1;
            }
          } else {
            const value = step.sameValue
              ? model.priority
              : step.priority === model.priority ? (model.priority + 1) % 5 : step.priority;
            const version = model.versions.priority;
            const expected = step.stale && version > 1 ? version - 1 : version;
            const operation = parseOperation({
              op: "update",
              id: issueId,
              changes: [{ field: "priority", value, expected }],
            });
            if (expected !== version) {
              await assert.rejects(executeOperation(store.db, operation, "hegel-test"), propertyIsConflict);
            } else {
              await executeOperation(store.db, operation, "hegel-test");
              model.priority = value;
              model.versions.priority += 1;
            }
          }

          const actual = await propertyShowIssue(store.db, issueId);
          assert.equal(actual.body, model.body);
          assert.equal(actual.priority, model.priority);
          assert.equal(actual.versions.body, model.versions.body);
          assert.equal(actual.versions.priority, model.versions.priority);
        }
      } finally {
        store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, { testCases: propertyCases, seed: 20261005, database: hegel.Database.fromPath(".hegel") });
  assert.equal(casesRun, propertyCases);
});


test("property: create retries replay the current issue without consuming another number", async () => {
  let casesRun = 0;
  await hegel.testAsync(async (tc) => {
    casesRun += 1;
    const root = mkdtempSync(join(tmpdir(), "polylinedb-hegel-create-"));
    const cwd = join(root, "work");
    const directory = join(root, "store");
    mkdirSync(cwd);

    try {
      initializeStore({ directory, cwd });
      const store = openStore({ directory, cwd });
      try {
        const body = tc.draw(propertyNonblankText(24));
        const changedBody = tc.draw(propertyNonblankText(24));
        const distinctBody = changedBody === body ? `${changedBody}!` : changedBody;
        const operation = {
          op: "create",
          prefix: "pd",
          request_id: "00000000-0000-4000-8000-000000000001",
          tool: "hegel",
          project: "create-retry-property",
          body,
          status: "open",
          type: "task",
          priority: tc.draw(gs.integers({ minValue: 0, maxValue: 4 })),
          labels: [],
        };
        const first = await executeOperation(store.db, parseOperation(operation), "hegel-test");
        assert.ok("issue" in first);
        assert.equal(first.issue.id, "pd-1");

        await executeOperation(store.db, parseOperation({
          op: "update",
          id: first.issue.id,
          changes: [{ field: "body", value: distinctBody, expected: 1 }],
        }), "hegel-test");
        const replay = await executeOperation(store.db, parseOperation(operation), "hegel-test");
        assert.ok("issue" in replay);
        assert.equal(replay.issue.id, "pd-1");
        assert.equal(replay.issue.body, distinctBody);
        assert.equal(replay.issue.versions.body, 2);

        await assert.rejects(executeOperation(store.db, parseOperation({ ...operation, body: distinctBody }), "hegel-test"), propertyHasCode("request_conflict"));
        await assert.rejects(executeOperation(store.db, parseOperation(operation), "other-actor"), propertyHasCode("request_conflict"));
        const next = await executeOperation(store.db, parseOperation({
          ...operation,
          request_id: "00000000-0000-4000-8000-000000000002",
        }), "hegel-test");
        assert.ok("issue" in next);
        assert.equal(next.issue.id, "pd-2");
      } finally {
        store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, { testCases: propertyCases, seed: 20261006, database: hegel.Database.fromPath(".hegel") });
  assert.equal(casesRun, propertyCases);
});
