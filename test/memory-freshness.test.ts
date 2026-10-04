// Checks project observations against real stores and supported restore boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, chmodSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { node } from 'solarsql/node';
import { executeOperation, parseOperation } from "../src/records/operations.ts";
import { initializeStore, openStore, upgradeStore } from "../src/local-store/index.ts";
import { SCHEMA_V2_SQL, SCHEMA_V3_SQL, ROTATE_MEMORY_IDENTITY_SQL, schemaUpgradeStatements } from "../src/records/schema.ts";
import type { SqlExecutor } from "../src/records/issues.ts";
import { executeCloudOperation } from '../src/cloud-client/cloud-operations.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pd-freshness-'));
  const location = { directory: join(root, 'store'), cwd: join(root, 'work') };
  const identity = { kind: 'local' as const, database_path: initializeStore(location).database_path };
  const store = openStore(location);
  let closed = false;
  const close = () => { store.close(); closed = true; };
  t.after(() => { if (!closed) store.close(); rmSync(root, { recursive: true, force: true }); });
  const run = (input: unknown, db: SqlExecutor = store.db, selected = identity) => executeOperation(db, parseOperation(input), 'test:reader', selected);
  const memory = (extra = {}) => ({ op: 'memory_create', project: 'demo', prefix: 'pd', title: 'Fact', body: 'Use npm test.', request_id: crypto.randomUUID(), ...extra });
  const context = (extra = {}) => run({ op: 'memory_context', project: 'demo', with_revision: true, ...extra });
  const revision = async (extra = {}) => { const output = await context(extra); assert('memory_revision' in output && typeof output.memory_revision === 'string'); return output.memory_revision; };
  const check = (token: string, extra = {}) => run({ op: 'list', project: 'demo', observed_memory_revision: token, ...extra });
  return { root, location, store, identity, run, memory, context, revision, check, close };
}
function freshness(output: Awaited<ReturnType<typeof executeOperation>>) {
  assert('memory_freshness' in output && output.memory_freshness); return output.memory_freshness;
}

test('accepted mutations, same-value replacements, deletion and ABA change the project observation', async t => {
  const f = fixture(t);
  const empty = await f.revision();
  assert.deepEqual(freshness(await f.check(empty)), { status: 'current', project: 'demo' });
  const request = f.memory(); await f.run(request);
  assert.deepEqual(freshness(await f.check(empty)), { status: 'stale', project: 'demo', reason: 'memory_changed' });
  const created = await f.revision();
  await f.run(request); assert.equal(await f.revision(), created);
  await assert.rejects(f.run({ ...request, body: 'Different' }), { code: 'request_conflict' });
  assert.equal(await f.revision(), created);
  await f.run({ op: 'memory_update', project: 'demo', id: 'pd-m1', title: 'Fact', body: 'Use npm test.', expected: 1 });
  assert.notEqual(await f.revision(), created);
  const updated = await f.revision();
  await assert.rejects(f.run({ op: 'memory_update', project: 'demo', id: 'pd-m1', title: 'Fact', body: 'Stale', expected: 1 }), { code: 'memory_conflict' });
  assert.equal(await f.revision(), updated);
  await f.run({ op: 'memory_delete', project: 'demo', id: 'pd-m1', expected: 2 });
  const deleted = await f.revision(); assert.notEqual(deleted, updated); assert.notEqual(deleted, empty);
  await assert.rejects(f.run(request), { code: 'memory_deleted' }); assert.equal(await f.revision(), deleted);
  assert.deepEqual(freshness(await f.check(empty)), { status: 'stale', project: 'demo', reason: 'memory_changed' });
});

test('partial pages, omitted Unicode entries, and concurrent clients retain project-wide observations', async t => {
  const f = fixture(t);
  await f.run(f.memory({ body: '日'.repeat(5000) }));
  await f.run(f.memory({ title: 'Small', body: 'Small fact' }));
  const page = await f.context({ limit: 1 }); assert('memory_revision' in page); assert.equal(page.omitted, true);
  const token = await f.revision();
  const bounded = await f.context({ max_bytes: 4096 }); assert('memory_revision' in bounded);
  assert.equal(bounded.memory_revision, token); assert.deepEqual(bounded.notices, [{ code: 'byte_limit', skipped_id: 'pd-m1' }]);
  assert(Buffer.byteLength(JSON.stringify(bounded)) <= 4096);
  const next = await f.context({ after: bounded.next_cursor, max_bytes: 4096 }); assert('memory_revision' in next);
  assert.equal(next.memory_revision, token); assert.equal(next.memories[0]?.body, 'Small fact');
  const other = openStore(f.location);
  try {
    await Promise.all([
      f.run(f.memory({ title: 'Third' })),
      f.run(f.memory({ title: 'Fourth' }), other.db),
    ]);
  } finally { other.close(); }
  const clock = new DatabaseSync(f.identity.database_path);
  try { assert.equal(clock.prepare("SELECT revision FROM project_memory_revisions WHERE project = 'demo'").get()?.revision, 4); } finally { clock.close(); }
  assert.equal(freshness(await f.check(token)).status, 'stale');
  const later = await f.context({ after: 'pd-m1', limit: 1 }); assert('memory_revision' in later); assert.notEqual(later.memory_revision, token);
  const seen = await f.revision();
  const interleaved: SqlExecutor = { ...f.store.db, batch: async statements => {
    const result = await f.store.db.batch(statements);
    await f.run({ op: 'memory_update', project: 'demo', id: 'pd-m2', title: 'Small', body: 'Changed after context snapshot', expected: 1 });
    return result;
  } };
  const coherent = await f.run({ op: 'memory_context', project: 'demo', after: 'pd-m1', with_revision: true }, interleaved);
  assert('memory_revision' in coherent); assert.equal(coherent.memory_revision, seen); assert.equal(coherent.memories[0]?.body, 'Small fact');
  assert.equal(freshness(await f.check(seen)).status, 'stale');
});

test('issue observation scope, replay receipts, opted-out JSON and advisory failures', async t => {
  const f = fixture(t);
  const token = await f.revision();
  const request = { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), project: 'demo', tool: 'test', body: 'Issue' };
  const created = await f.run({ ...request, observed_memory_revision: token }); assert('issue' in created);
  const old = await f.run(request); assert.deepEqual(Object.keys(old), ['issue']);
  const plainContext = await f.run({ op: 'memory_context', project: 'demo' }); assert.deepEqual(Object.keys(plainContext), ['project', 'store', 'memories', 'limits', 'omitted', 'next_cursor', 'notices']);
  await f.run(f.memory()); const newToken = await f.revision();
  const replay = await f.run({ ...request, observed_memory_revision: newToken }); assert('issue' in replay); assert.deepEqual(replay.issue, created.issue);
  const snapshot = f.store.exportSnapshot(); assert.equal(snapshot.version, 3); assert.equal(snapshot.requests[0]?.payload.includes('observed_memory_revision'), false);
  assert.deepEqual(freshness(await f.check(newToken, { project: 'other' })), { status: 'stale', project: 'other', reason: 'project_changed' });
  assert.deepEqual(freshness(await f.run({ op: 'list', observed_memory_revision: newToken })), { status: 'current', project: 'demo' });
  const moved = await f.run({ op: 'update', id: created.issue.id, changes: [{ field: 'project', value: 'other', expected: 1 }], observed_memory_revision: newToken });
  assert.deepEqual(freshness(moved), { status: 'stale', project: 'other', reason: 'project_changed' });
  const failed: SqlExecutor = { ...f.store.db, reads: { all: async () => { throw new Error('offline advisory'); } } };
  const success = await f.run({ op: 'comment', id: created.issue.id, body: 'Completed', observed_memory_revision: newToken }, failed);
  assert('comment' in success); assert.deepEqual(freshness(success), { status: 'unavailable', project: 'demo' });
  const shown = await f.run({ op: 'show', id: created.issue.id }); assert('comments' in shown); assert.equal(shown.comments[0]?.body, 'Completed');
  assert.deepEqual(Object.keys(shown), ['issue', 'comments']);
  assert.deepEqual(Object.keys(await f.run({ op: 'list' })), ['issues', 'next_cursor']);
  assert.deepEqual(Object.keys(await f.run({ op: 'search', query: 'Issue' })), ['issues', 'next_cursor']);
  assert.deepEqual(Object.keys(await f.run({ op: 'actor' })), ['actor']);
  assert.deepEqual(Object.keys(await f.run({ op: 'comment', id: created.issue.id, body: 'Plain comment' })), ['comment']);
  assert.deepEqual(Object.keys(await f.run({ op: 'update', id: created.issue.id, changes: [{ field: 'body', value: 'Changed issue', expected: 1 }] })), ['issue']);
  assert.deepEqual(Object.keys(await f.run({ op: 'close', id: created.issue.id, expected: 1 })), ['issue']);
  assert.deepEqual(Object.keys(await f.run({ op: 'reopen', id: created.issue.id, expected: 2 })), ['issue']);
  for (const input of ['broken', '', 'pm1.00']) assert.throws(() => parseOperation({ ...request, request_id: crypto.randomUUID(), observed_memory_revision: input }), { code: 'invalid_input' });
  assert.equal(f.store.exportSnapshot().issues.length, 1);
  assert.throws(() => parseOperation({ op: 'actor', observed_memory_revision: token }), { code: 'invalid_input' });
  assert.throws(() => parseOperation({ op: 'memory_list', project: 'demo', observed_memory_revision: token }), { code: 'invalid_input' });
  assert.throws(() => parseOperation({ op: 'memory_context', project: 'demo', with_revision: false }), { code: 'invalid_input' });
});

test('comment scope is sampled after completion and includes a concurrent project move', async t => {
  const f = fixture(t); const token = await f.revision();
  const created = await f.run({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), project: 'demo', tool: 'test', body: 'Issue' }); assert('issue' in created);
  const concurrent = openStore(f.location);
  try {
    const interleaved: SqlExecutor = { ...f.store.db, batch: async statements => {
      const result = await f.store.db.batch(statements);
      await f.run({ op: 'update', id: created.issue.id, changes: [{ field: 'project', value: 'moved', expected: 1 }] }, concurrent.db);
      return result;
    } };
    const output = await f.run({ op: 'comment', id: created.issue.id, body: 'Before move', observed_memory_revision: token }, interleaved);
    assert('comment' in output); assert.deepEqual(freshness(output), { status: 'stale', project: 'moved', reason: 'project_changed' });
  } finally { concurrent.close(); }
});

test('store identity, imports and raw rollback at the same path require incarnation rotation', async t => {
  const f = fixture(t); await f.run(f.memory());
  const before = await f.revision(); const snapshot = f.store.exportSnapshot();
  const destinationLocation = { directory: join(f.root, 'destination'), cwd: f.location.cwd };
  const destinationIdentity = { kind: 'local' as const, database_path: initializeStore(destinationLocation).database_path };
  const destination = openStore(destinationLocation);
  try {
    const emptyOutput = await f.run({ op: 'memory_context', project: 'demo', with_revision: true }, destination.db, destinationIdentity); assert('memory_revision' in emptyOutput);
    destination.importSnapshot(snapshot);
    assert.deepEqual(freshness(await f.run({ op: 'list', project: 'demo', observed_memory_revision: before }, destination.db, destinationIdentity)), { status: 'stale', project: 'demo', reason: 'store_changed' });
    const imported = await f.run({ op: 'memory_context', project: 'demo', with_revision: true }, destination.db, destinationIdentity); assert('memory_revision' in imported); assert.notEqual(imported.memory_revision, emptyOutput.memory_revision);
    assert.equal(destination.importSnapshot(snapshot).result, 'already_present');
    const repeated = await f.run({ op: 'memory_context', project: 'demo', with_revision: true }, destination.db, destinationIdentity); assert('memory_revision' in repeated); assert.equal(repeated.memory_revision, imported.memory_revision);
    assert.deepEqual(destination.exportSnapshot(), snapshot);
  } finally { destination.close(); }
  const backup = join(f.root, 'backup.sqlite'); f.close(); copyFileSync(f.identity.database_path, backup);
  let reopened = openStore(f.location);
  try { await f.run(f.memory(), reopened.db); } finally { reopened.close(); }
  copyFileSync(backup, f.identity.database_path); reopened = openStore(f.location);
  try {
    const output = await f.run({ op: 'list', project: 'demo', observed_memory_revision: before }, reopened.db); assert.equal(freshness(output).status, 'current');
  } finally { reopened.close(); }
  const restored = new DatabaseSync(f.identity.database_path); restored.exec(ROTATE_MEMORY_IDENTITY_SQL); restored.close();
  reopened = openStore(f.location);
  try { assert.deepEqual(freshness(await f.run({ op: 'list', project: 'demo', observed_memory_revision: before }, reopened.db)), { status: 'stale', project: 'demo', reason: 'store_changed' }); }
  finally { reopened.close(); }
});

test('schema 2 and 3 upgrades retain content, reject altered schemas, and roll back failed migration batches', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pd-freshness-upgrade-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const version of [2, 3] as const) {
    const directory = join(root, `v${version}`); mkdirSync(directory, { mode: 0o700 }); const path = join(directory, 'polylinedb.sqlite');
    const db = new DatabaseSync(path); db.exec(version === 2 ? SCHEMA_V2_SQL : SCHEMA_V3_SQL);
    const legacy: SqlExecutor = { reads: node(db), batch: async statements => {
      db.exec('BEGIN IMMEDIATE');
      try { const output = statements.map(({ sql, params }) => ({ rows: db.prepare(sql).all(...params) })); db.exec('COMMIT'); return output; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    } };
    const request = { op: 'memory_create', prefix: 'pd', project: 'existing', request_id: crypto.randomUUID(), title: 'Old fact', body: 'Keep this fact' };
    if (version === 3) await executeOperation(legacy, parseOperation(request), 'old:author');
    db.exec('BEGIN IMMEDIATE');
    assert.throws(() => db.exec(schemaUpgradeStatements(version).join(';') + ';INSERT INTO absent VALUES (1);'));
    db.exec('ROLLBACK'); assert.equal(db.prepare('SELECT version FROM schema_version').get()?.version, version);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'memory_store_identity'").get()?.n, 0);
    db.close(); chmodSync(path, 0o600);
    const location = { directory, cwd: join(root, 'work') }; assert.equal(upgradeStore(location).version, 4); assert.equal(upgradeStore(location).result, 'already_current');
    const store = openStore(location);
    try {
      const output = await executeOperation(store.db, parseOperation({ op: 'memory_context', project: 'empty', with_revision: true }), 'reader', { kind: 'local', database_path: path }); assert('memory_revision' in output);
      if (version === 3) {
        const replay = await executeOperation(store.db, parseOperation(request), 'old:author'); assert('memory' in replay); assert.equal(replay.memory.body, 'Keep this fact'); assert.equal(replay.memory.created_by, 'old:author');
        assert.equal(store.exportSnapshot().memories.length, 1);
      }
    } finally { store.close(); }
  }
  const directory = join(root, 'bad'); mkdirSync(directory, { mode: 0o700 }); const path = join(directory, 'polylinedb.sqlite');
  const bad = new DatabaseSync(path); bad.exec(SCHEMA_V3_SQL + 'CREATE TABLE extra(id TEXT);'); bad.close(); chmodSync(path, 0o600);
  assert.throws(() => upgradeStore({ directory, cwd: join(root, 'work') }), { code: 'invalid_store' });
  const after = new DatabaseSync(path); try { assert.equal(after.prepare('SELECT version FROM schema_version').get()?.version, 3); } finally { after.close(); }
});

test('clock exhaustion rolls back writes and immutable memory projects prevent cross-project movement', async t => {
  const f = fixture(t); await f.run(f.memory());
  const direct = new DatabaseSync(f.identity.database_path);
  try {
    assert.throws(() => direct.exec("UPDATE memories SET project = 'other' WHERE id = 'pd-m1'"), /memory_identity_immutable/);
    direct.exec(`UPDATE project_memory_revisions SET revision = ${Number.MAX_SAFE_INTEGER} WHERE project = 'demo'`);
  } finally { direct.close(); }
  const token = await f.revision();
  await assert.rejects(f.run({ op: 'memory_update', project: 'demo', id: 'pd-m1', title: 'New', body: 'New', expected: 1 }), { code: 'memory_revision_exhausted' });
  await assert.rejects(f.run(f.memory()), { code: 'memory_revision_exhausted' });
  await assert.rejects(f.run({ op: 'memory_delete', project: 'demo', id: 'pd-m1', expected: 1 }), { code: 'memory_revision_exhausted' });
  assert.equal(await f.revision(), token); const shown = await f.run({ op: 'memory_show', project: 'demo', id: 'pd-m1' }); assert('memory' in shown); assert.equal(shown.memory.version, 1); assert.equal(f.store.exportSnapshot().memory_counters[0]?.last_number, 1);
});

test('cloud boundary requires opted-in fields and validates advisory scope', async t => {
  const f = fixture(t);
  const cloud = { kind: 'cloud' as const, url: 'https://synthetic.example' };
  const context = await executeOperation(f.store.db, parseOperation({ op: 'memory_context', project: 'demo', with_revision: true }), 'access:reader', cloud); assert('memory_revision' in context);
  const token = context.memory_revision;
  const call = (input: unknown, response: unknown) => executeCloudOperation({ origin: cloud.url, operation: parseOperation(input), authorize: async () => 'synthetic', fetch: async () => Response.json(response) });
  assert.deepEqual(await call({ op: 'memory_context', project: 'demo', with_revision: true }, context), context);
  await assert.rejects(call({ op: 'memory_context', project: 'demo' }, context), { code: 'cloud_invalid_response' });
  const request = { op: 'list', project: 'demo', observed_memory_revision: token };
  const output = { issues: [], next_cursor: null, memory_freshness: { status: 'current', project: 'demo' } };
  assert.deepEqual(await call(request, output), output);
  for (const broken of [{ issues: [], next_cursor: null }, { ...output, memory_freshness: { status: 'current', project: 'other' } }, { ...output, memory_freshness: { status: 'stale', project: 'demo', reason: 'invented' } }]) await assert.rejects(call(request, broken), { code: 'cloud_invalid_response' });
  const replaced = { kind: 'cloud' as const, url: 'https://other-account.example' };
  const switched = await executeOperation(f.store.db, parseOperation(request), 'access:reader', replaced); assert.deepEqual(freshness(switched), { status: 'stale', project: 'demo', reason: 'store_changed' });
  const accountLocation = { directory: join(f.root, 'replacement-account'), cwd: f.location.cwd };
  initializeStore(accountLocation); const account = openStore(accountLocation);
  try {
    const rebound = await executeOperation(account.db, parseOperation(request), 'access:reader', cloud);
    assert.deepEqual(freshness(rebound), { status: 'stale', project: 'demo', reason: 'store_changed' });
  } finally { account.close(); }
});
