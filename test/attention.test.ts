// Exercises the Attention read with real SQLite, the same store fixture as the issue tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attentionIssues, executeOperation, parseOperation } from '../src/records/index.ts';
import type { Issue, OpenIssue } from '../src/records/index.ts';
import type { SqlExecutor } from '../src/records/store/sql.ts';
import { initializeStore, openStore } from '../src/local-store/index.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'polylinedb-attention-'));
  const directory = join(root, 'store');
  const cwd = join(root, 'work');
  initializeStore({ directory, cwd });
  const opened = openStore({ directory, cwd });
  t.after(() => { opened.close(); rmSync(root, { recursive: true, force: true }); });
  return opened.db;
}

const execute = (db: SqlExecutor, operation: unknown) => executeOperation(db, parseOperation(operation), 'tester');

async function create(db: SqlExecutor, extra: Record<string, unknown> = {}): Promise<Issue> {
  const result = await execute(db, {
    op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'compiler', project: 'parser', body: 'Body', ...extra,
  });
  assert.ok('issue' in result);
  return result.issue;
}

async function start(db: SqlExecutor, issue: Issue): Promise<Issue> {
  const shown = await execute(db, { op: 'claim_show', issue_id: issue.id });
  assert.ok('claim' in shown);
  const session_id = crypto.randomUUID();
  const acquired = await execute(db, { op: 'claim_acquire', issue_id: issue.id, incarnation: shown.claim.store_incarnation, session_id, request_id: crypto.randomUUID() });
  assert.ok('claim_receipt' in acquired);
  const claim_proof = { issue_id: issue.id, incarnation: acquired.claim_receipt.incarnation, session_id, generation: acquired.claim_receipt.generation };
  const started = await execute(db, { op: 'update', id: issue.id, changes: [{ field: 'status', value: 'in_progress', expected: issue.versions.status }], claim_proof });
  assert.ok('issue' in started);
  return started.issue;
}

function ago(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

async function stamp(db: SqlExecutor, id: string, createdAt: string, updatedAt: string): Promise<void> {
  await db.batch([{ sql: 'UPDATE issues SET created_at = ?, updated_at = ? WHERE id = ?', params: [createdAt, updatedAt, id] }]);
}

test('attentionIssues groups open owner issues and keeps main-wait in read order', async (t) => {
  const db = fixture(t);
  const day = 86400;
  const decision = await create(db, { body: 'D', labels: ['owner-decision'], priority: 2 });
  const both = await create(db, { body: 'B', labels: ['owner-decision', 'owner-action'], priority: 0 });
  const actionOld = await create(db, { body: 'A1', labels: ['owner-action'], priority: 1 });
  const actionMid = await create(db, { body: 'A2', labels: ['owner-action'], priority: 1 });
  const actionLow = await create(db, { body: 'A3', labels: ['owner-action'], priority: 3 });
  const mainAndAction = await create(db, { body: 'MA', labels: ['main-wait', 'owner-action'], priority: 2 });
  const main = await create(db, { body: 'M', labels: ['main-wait'] });
  const deferred = await create(db, { body: 'DEF', status: 'deferred', labels: ['owner-action'] });
  const progress = await start(db, await create(db, { body: 'IP', labels: ['owner-decision'] }));
  const closed = await create(db, { body: 'C', status: 'closed', labels: ['owner-decision'] });
  const ready = await create(db, { body: 'R', labels: ['ready'] });
  await stamp(db, decision.id, ago(2 * day), '2026-10-02T00:00:00.000Z');
  await stamp(db, both.id, ago(3600), '2026-10-03T00:00:00.000Z');
  await stamp(db, actionOld.id, ago(3 * day), '2026-10-04T00:00:00.000Z');
  await stamp(db, actionMid.id, ago(day), '2026-10-05T00:00:00.000Z');
  await stamp(db, actionLow.id, ago(5 * day), '2026-10-06T00:00:00.000Z');
  await stamp(db, mainAndAction.id, ago(3600), '2026-10-11T00:00:00.000Z');
  await stamp(db, main.id, ago(3600), '2026-10-01T00:00:00.000Z');

  const attention = await attentionIssues(db);
  assert.deepEqual(attention.waitingOnOwner.groups.map(group => group.label), ['owner-decision', 'owner-action']);
  const listed: readonly (readonly OpenIssue[])[] = attention.waitingOnOwner.groups.map(group => group.issues);
  assert.deepEqual(listed.map(issues => issues.map(issue => issue.id)), [
    [both.id, decision.id],
    [actionOld.id, actionMid.id, mainAndAction.id, actionLow.id],
  ]);
  for (const issue of listed.flat()) assert.equal(issue.status, 'open');
  assert.equal(attention.waitingOnOwner.notOpen, 2);
  assert.deepEqual(attention.waitingForMain.map(issue => issue.id), [mainAndAction.id, main.id]);
  assert.equal(attention.more, false);

  const ids = attention.issues.map(row => row.issue.id);
  assert.equal(ids.includes(closed.id), false);
  assert.equal(ids.includes(ready.id), false);
  assert.equal(ids.includes(deferred.id), true);
  assert.equal(ids.includes(progress.id), true);
  const mainRow = attention.issues.find(row => row.issue.id === mainAndAction.id);
  assert.ok(mainRow);
  assert.deepEqual(mainRow.labels, ['owner-action', 'main-wait']);
  const aged = attention.issues.find(row => row.issue.id === actionOld.id);
  assert.ok(aged?.waitingSeconds !== null && aged?.waitingSeconds !== undefined);
  assert.ok(Math.abs(aged.waitingSeconds - 3 * day) <= 5);
});

test('attention keeps an empty owner group', async (t) => {
  const db = fixture(t);
  const main = await create(db, { labels: ['main-wait'], body: 'main' });
  const attention = await attentionIssues(db);
  assert.deepEqual(attention.waitingOnOwner.groups.map(group => [group.label, group.issues.map(issue => issue.id)]), [
    ['owner-decision', []],
    ['owner-action', []],
  ]);
  assert.equal(attention.waitingOnOwner.notOpen, 0);
  assert.deepEqual(attention.waitingForMain.map(issue => issue.id), [main.id]);
});

test('attention sorts equal priority and age by issue id', async (t) => {
  const db = fixture(t);
  const earlier = await create(db, { body: 'earlier', labels: ['owner-action'], priority: 1 });
  const later = await create(db, { body: 'later', labels: ['owner-action'], priority: 1 });
  const created = '2026-10-01T00:00:00.000Z';
  await db.batch([
    { sql: 'UPDATE issues SET created_at = ?, updated_at = ? WHERE id = ?', params: [created, created, earlier.id] },
    { sql: 'UPDATE issues SET created_at = ?, updated_at = ? WHERE id = ?', params: [created, created, later.id] },
  ]);
  const attention = await attentionIssues(db);
  const action = attention.waitingOnOwner.groups.find(group => group.label === 'owner-action');
  assert.ok(action);
  assert.deepEqual(action.issues.map(issue => issue.id), [earlier.id, later.id]);
});

test('attention clamps a future age to zero and sorts an unreadable created_at last', async (t) => {
  const db = fixture(t);
  const aged = await create(db, { labels: ['owner-action'], priority: 1, body: 'aged' });
  const future = await create(db, { labels: ['owner-action'], priority: 1, body: 'future' });
  const garbage = await create(db, { labels: ['owner-action'], priority: 1, body: 'garbage' });
  await db.batch([
    { sql: 'UPDATE issues SET created_at = ? WHERE id = ?', params: [ago(2 * 86400), aged.id] },
    { sql: 'UPDATE issues SET created_at = ? WHERE id = ?', params: [new Date(Date.now() + 3600 * 1000).toISOString(), future.id] },
    { sql: 'UPDATE issues SET created_at = ? WHERE id = ?', params: ['garbage', garbage.id] },
  ]);
  const attention = await attentionIssues(db);
  const action = attention.waitingOnOwner.groups.find(group => group.label === 'owner-action');
  assert.ok(action);
  assert.deepEqual(action.issues.map(issue => issue.id), [aged.id, future.id, garbage.id]);
  const seconds = new Map(attention.issues.map(row => [row.issue.id, row.waitingSeconds]));
  assert.equal(seconds.get(future.id), 0);
  assert.equal(seconds.get(garbage.id), null);
});

test('attention returns 100 issues and omits the least recently updated priority-0 owner issue', async (t) => {
  const db = fixture(t);
  const ids: string[] = [];
  for (let index = 0; index < 101; index += 1) {
    const issue = await create(db, { body: `n${index}`, labels: ['owner-action'], priority: index === 0 ? 0 : 2 });
    ids.push(issue.id);
  }
  const oldest = ids[0];
  assert.equal(typeof oldest, 'string');
  await db.batch([{
    sql: 'UPDATE issues SET priority = 0, created_at = ?, updated_at = ? WHERE id = ?',
    params: ['2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z', oldest],
  }]);
  const attention = await attentionIssues(db);
  assert.equal(attention.issues.length, 100);
  assert.equal(attention.more, true);
  assert.equal(attention.issues.some(row => row.issue.id === oldest), false);
  assert.equal(attention.waitingOnOwner.groups.some(group => group.issues.some(issue => issue.id === oldest)), false);
});
