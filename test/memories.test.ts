// Exercises durable project knowledge through real stores, including stale writers and snapshot recovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { node } from 'solarsql/node';
import { initializeStore, openStore, upgradeStore } from "../src/local-store/index.ts";
import { executeOperation, parseOperation } from "../src/records/operations.ts";
import { canonicalSnapshot, convertSnapshotV2, parseSnapshot } from "../src/records/snapshot.ts";
import { SCHEMA_V2_SQL } from "../src/records/schema.ts";
import type { SqlExecutor } from "../src/records/issues.ts";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pd-memory-'));
  const location = { directory: join(root, 'store'), cwd: join(root, 'work') };
  const identity = { kind: 'local' as const, database_path: join(location.directory, 'polylinedb.sqlite') };
  initializeStore(location);
  const store = openStore(location);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const run = (input: unknown, actor = 'test:memory') => executeOperation(store.db, parseOperation(input), actor, identity);
  const creation = (extra: Record<string, unknown> = {}) => ({ op: 'memory_create', project: 'project', prefix: 'pd', request_id: crypto.randomUUID(), title: 'Build', body: 'Run npm test.', ...extra });
  return { root, store, run, creation, location, identity };
}

test('memories preserve scope, audit, replay, natural IDs, and deliberate conflicts', async t => {
  const { run, creation, location } = fixture(t);
  const request = creation();
  const first = await run(request); assert('memory' in first);
  assert.equal(first.memory.id, 'pd-m1'); assert.equal(first.memory.version, 1);
  assert.equal(first.memory.created_by, 'test:memory');
  assert.deepEqual(await run(request), first);
  await assert.rejects(run({ ...request, body: 'Changed' }), { code: 'request_conflict' });
  await assert.rejects(run(request, 'other'), { code: 'request_conflict' });
  await assert.rejects(run({ op: 'memory_show', project: 'other', id: 'pd-m1' }), { code: 'memory_not_found' });
  const otherConnection = openStore(location);
  try {
    const update = { op: 'memory_update', project: 'project', id: 'pd-m1', title: 'Build', body: 'Updated', expected: 1 };
    const writes = await Promise.allSettled([run(update), executeOperation(otherConnection.db, parseOperation({ ...update, body: 'Concurrent' }), 'other')]);
    assert.equal(writes.filter(value => value.status === 'fulfilled').length, 1);
    const failure = writes.find(value => value.status === 'rejected');
    assert(failure?.status === 'rejected'); assert.equal(failure.reason.code, 'memory_conflict');
    assert.equal(failure.reason.details.memory.version, 2);
  } finally { otherConnection.close(); }
  const updated = await run(request); assert('memory' in updated); assert.equal(updated.memory.version, 2);
  await assert.rejects(run({ op: 'memory_delete', project: 'other', id: 'pd-m1', expected: 2 }), { code: 'memory_not_found' });
  await assert.rejects(run({ op: 'memory_delete', project: 'project', id: 'pd-m1', expected: 1 }), { code: 'memory_conflict' });
  assert.deepEqual(await run({ op: 'memory_delete', project: 'project', id: 'pd-m1', expected: 2 }), { deleted: { project: 'project', id: 'pd-m1', version: 2 } });
  await assert.rejects(run(request), { code: 'memory_deleted' });
  for (let i = 0; i < 11; i++) await run(creation({ project: i === 0 ? 'other' : 'project', title: `Fact ${i}` }));
  const list = await run({ op: 'memory_list', project: 'project', after: 'pd-m8', limit: 3 });
  assert('memories' in list); assert.deepEqual(list.memories.map(value => value.id), ['pd-m9', 'pd-m10', 'pd-m11']); assert.equal(list.next_cursor, 'pd-m11');
  const found = await run({ op: 'memory_search', project: 'project', query: 'Fact 10' });
  assert('memories' in found); assert.deepEqual(found.memories.map(value => value.id), ['pd-m12']);
  assert.throws(() => parseOperation({ op: 'memory_list' }), { code: 'invalid_input' });
});

test('context distinguishes empty, omitted, and unavailable storage and bounds serialized Unicode', async t => {
  const { run, creation, store, identity } = fixture(t);
  const empty = await run({ op: 'memory_context', project: 'project' });
  assert('omitted' in empty); assert.equal(empty.omitted, false); assert.deepEqual(empty.memories, []); assert.deepEqual(empty.store, identity);
  const huge = await run(creation({ body: '日'.repeat(5000) })); assert('memory' in huge);
  await run(creation({ title: 'Small', body: 'Useful fact' }));
  const bounded = await run({ op: 'memory_context', project: 'project', max_bytes: 4096 });
  assert('omitted' in bounded); assert.equal(bounded.omitted, true);
  assert.deepEqual(bounded.notices, [{ code: 'byte_limit', skipped_id: 'pd-m1' }]);
  assert.equal(bounded.next_cursor, 'pd-m1'); assert(Buffer.byteLength(JSON.stringify(bounded)) <= 4096);
  const next = await run({ op: 'memory_context', project: 'project', after: bounded.next_cursor, max_bytes: 4096 });
  assert('omitted' in next); assert.equal(next.memories[0]?.body, 'Useful fact'); assert.equal(next.omitted, false);
  const limited = await run({ op: 'memory_context', project: 'project', limit: 1 });
  assert('omitted' in limited); assert.equal(limited.memories.length, 1); assert.deepEqual(limited.notices, [{ code: 'entry_limit' }]);
  await assert.rejects(executeOperation({ ...store.db, reads: { all: async () => { throw new Error('offline'); } } }, parseOperation({ op: 'memory_context', project: 'project' }), 'reader', identity), /offline/);
});

test('snapshot preserves memories, deletion receipts, and issued numbers', async t => {
  const { root, run, creation, store } = fixture(t);
  const deleted = creation(); await run(deleted);
  await run({ op: 'memory_delete', project: 'project', id: 'pd-m1', expected: 1 });
  await run(creation({ title: 'Retain' }));
  await run({ op: 'memory_update', project: 'project', id: 'pd-m2', title: 'Retained', body: 'Confirmed', expected: 1 }, 'test:editor');
  const snapshot = store.exportSnapshot(); assert.equal(snapshot.version, 4);
  const restoredLocation = { directory: join(root, 'restored'), cwd: join(root, 'work') };
  initializeStore(restoredLocation); const restored = openStore(restoredLocation);
  try {
    assert.equal(restored.importSnapshot(snapshot).result, 'imported');
    assert.equal(canonicalSnapshot(restored.exportSnapshot()), canonicalSnapshot(snapshot));
    assert.equal(restored.importSnapshot(snapshot).result, 'already_present');
    await assert.rejects(executeOperation(restored.db, parseOperation(deleted), 'test:memory'), { code: 'memory_deleted' });
    const next = await executeOperation(restored.db, parseOperation(creation()), 'test:memory');
    assert('memory' in next); assert.equal(next.memory.id, 'pd-m3');
    assert.throws(() => restored.importSnapshot(snapshot), { code: 'destination_not_empty' });
    assert.throws(() => parseSnapshot({ ...snapshot, memory_counters: [] }), { code: 'invalid_snapshot' });
    for (const altered of [
      { ...snapshot, memory_requests: [] },
      { ...snapshot, memory_counters: [{ prefix: 'pd', last_number: 1 }] },
      { ...snapshot, memory_requests: snapshot.memory_requests.map(row => row.memory_id === 'pd-m2' ? { ...row, actor: 'wrong' } : row) },
      { ...snapshot, memory_requests: snapshot.memory_requests.map(row => ({ ...row, payload: '{}' })) },
      { ...snapshot, memories: snapshot.memories.map(row => ({ ...row, project: 'other' })) },
      { ...snapshot, memory_requests: snapshot.memory_requests.map(row => ({ ...row, memory_id: 'other-m1' })) },
    ]) assert.throws(() => parseSnapshot(altered), { code: 'invalid_snapshot' });
  } finally { restored.close(); }
});

test('schema upgrade is explicit and v2 snapshot conversion retains issue data', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pd-upgrade-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'store'); mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, 'polylinedb.sqlite');
  const old = new DatabaseSync(path); old.exec(SCHEMA_V2_SQL);
  const legacy: SqlExecutor = { reads: node(old), batch: async statements => {
    old.exec('BEGIN IMMEDIATE');
    try { const result = statements.map(({ sql, params }) => ({ rows: old.prepare(sql).all(...params) })); old.exec('COMMIT'); return result; }
    catch (error) { old.exec('ROLLBACK'); throw error; }
  } };
  const request = parseOperation({ op: 'create', prefix: 'old', project: 'legacy', tool: 'tool', request_id: crypto.randomUUID(), body: 'Before upgrade' });
  await executeOperation(legacy, request, 'legacy:creator');
  await executeOperation(legacy, parseOperation({ op: 'comment', id: 'old-1', body: 'Original comment' }), 'legacy:commenter');
  old.exec("UPDATE issues SET body = 'Edited before upgrade', body_v = 2, updated_by = 'legacy:editor' WHERE id = 'old-1'");
  const shown = await executeOperation(legacy, parseOperation({ op: 'show', id: 'old-1' }), 'legacy:editor');
  assert('issue' in shown); const edited = { issue: shown.issue };
  const oldComments = old.prepare('SELECT * FROM comments').all();
  const oldCounters = old.prepare('SELECT * FROM counters').all();
  const oldRequests = old.prepare('SELECT * FROM requests').all();
  const oldSnapshot = { format: 'polylinedb.snapshot', version: 2, issues: [edited.issue], comments: oldComments, counters: oldCounters, requests: oldRequests };
  old.close(); chmodSync(path, 0o600);
  const location = { directory, cwd: join(root, 'work') };
  assert.throws(() => openStore(location), { code: 'unsupported_schema' });
  assert.equal(upgradeStore(location).result, 'upgraded');
  assert.equal(upgradeStore(location).result, 'already_current');
  const store = openStore(location);
  try {
    assert.throws(() => parseSnapshot(oldSnapshot), { code: 'invalid_snapshot' });
    assert.equal(canonicalSnapshot(convertSnapshotV2(oldSnapshot)), canonicalSnapshot(store.exportSnapshot()));
    assert.deepEqual(await executeOperation(store.db, request, 'legacy:creator'), edited);
    assert.equal(store.exportSnapshot().comments[0]?.created_by, 'legacy:commenter');
    const next = await executeOperation(store.db, parseOperation({ op: 'create', prefix: 'old', project: 'legacy', tool: 'tool', request_id: crypto.randomUUID(), body: 'After upgrade' }), 'legacy:creator');
    assert('issue' in next); assert.equal(next.issue.id, 'old-2');
  } finally { store.close(); }
});
