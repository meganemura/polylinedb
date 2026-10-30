// Exercises external resources on SQLite through the shared flow; the D1 run uses the same flow.
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initializeStore, openStore, upgradeStore } from '../src/local-store/index.ts';
import { executeOperation, parseOperation } from '../src/records/index.ts';
import { SCHEMA_SQL, SCHEMA_V8_SQL, canonicalSnapshot, convertSnapshotV6, parseSnapshot } from '../src/records/persistence/persistence.ts';
import { downgradeToSchema8 } from './fixtures/legacy-schema.ts';
import { runResourceFlow } from './fixtures/resource-flow.ts';

test('resources on SQLite: receipts, replays, conflicts, forward-only marks, the close guard, live listing, feed, and the agent gate', async t => {
  const { location } = localStore(t); const store = openStore(location);
  t.after(() => store.close());
  await runResourceFlow(async (value, caller = 'test:owner') => executeOperation(store.db, parseOperation(value), caller), 'test:owner');
});

function localStore(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pd-resources-'));
  const location = { directory: join(root, 'store'), cwd: join(root, 'work') };
  mkdirSync(location.cwd);
  const { database_path } = initializeStore(location);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, location, database_path };
}

test('a resource snapshot round-trips, a snapshot 6 converts with no resources, and invalid entries are refused', async t => {
  const { location } = localStore(t);
  const source = openStore(location);
  let snapshot;
  try {
    const run = (value: Record<string, unknown>) => executeOperation(source.db, parseOperation(value), 'test:owner');
    await run({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'snapshot', body: 'Preview' });
    await run({ op: 'resource_add', issue_id: 'pd-1', kind: 'worker', name: 'preview-api', expected_revision: 1, request_id: crypto.randomUUID() });
    await run({ op: 'resource_update', issue_id: 'pd-1', seq: 1, external_id: 'api-1', mark: 'created', expected_revision: 2, request_id: crypto.randomUUID() });
    snapshot = source.exportSnapshot();
  } finally { source.close(); }
  const [entry] = snapshot.issue_resources;
  assert.ok(entry);
  assert.deepEqual([snapshot.resource_revisions, snapshot.resource_requests.map(row => [row.issue_id, row.seq, row.result_revision, row.outcome]).sort()],
    [[{ issue_id: 'pd-1', revision: 3 }], [['pd-1', 1, 2, 'added'], ['pd-1', 1, 3, 'updated']]]);
  assert.deepEqual({ ...entry, added_at: 'store', created_at: 'store' }, { issue_id: 'pd-1', seq: 1, kind: 'worker', name: 'preview-api', external_id: 'api-1',
    created_at: 'store', deleted_at: null, verified_deleted_at: null, verified_by: null, evidence: null, added_at: 'store', added_by: 'test:owner' });
  const restored = localStore(t); const target = openStore(restored.location);
  try {
    const imported = target.importSnapshot(snapshot);
    assert.deepEqual([imported.result, imported.issue_resources, imported.resource_requests], ['imported', 1, 2]);
    assert.equal(canonicalSnapshot(target.exportSnapshot()), canonicalSnapshot(snapshot));
    await assert.rejects(executeOperation(target.db, parseOperation({ op: 'close', id: 'pd-1', expected: 1 }), 'test:owner'), { code: 'resources_remaining' });
  } finally { target.close(); }

  const { issue_resources: _entries, resource_revisions: _revisions, resource_requests: _requests, land_order: _edges, land_order_revisions: _orders, land_order_requests: _orderRequests, stars: _stars, issue_items: _items, ...rest } = snapshot;
  const converted = convertSnapshotV6({ ...rest, version: 6 });
  assert.deepEqual([converted.version, converted.issue_resources, converted.resource_revisions, converted.resource_requests], [10, [], [], []]);

  const refused = (change: Record<string, unknown>) => assert.throws(() => parseSnapshot({ ...snapshot, ...change }), { code: 'invalid_snapshot' }, JSON.stringify(change));
  refused({ issue_resources: [{ ...entry, issue_id: 'pd-9' }] });
  refused({ issue_resources: [entry, entry] });
  refused({ issue_resources: [{ ...entry, kind: 'Worker' }] });
  refused({ issue_resources: [{ ...entry, name: 'two words' }] });
  refused({ issue_resources: [{ ...entry, created_at: null, deleted_at: entry.created_at }] });
  refused({ issue_resources: [{ ...entry, verified_deleted_at: entry.created_at }] });
  refused({ issue_resources: [{ ...entry, created_at: 'yesterday' }] });
  refused({ resource_revisions: [] });
  refused({ resource_revisions: [{ issue_id: 'pd-1', revision: 1 }] });
  refused({ resource_requests: snapshot.resource_requests.map(row => ({ ...row, seq: 2 })) });
  refused({ resource_requests: snapshot.resource_requests.map(row => ({ ...row, outcome: 'added' })) });
});

test('a schema 8 store upgrades to the canonical schema 9 DDL and then records resources', async t => {
  const { location, database_path } = localStore(t);
  const legacy = new DatabaseSync(database_path); downgradeToSchema8(legacy);
  const reference = new DatabaseSync(':memory:'); reference.exec(SCHEMA_V8_SQL);
  const schema = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
  try { assert.deepEqual(legacy.prepare(schema).all(), reference.prepare(schema).all()); } finally { legacy.close(); reference.close(); }
  assert.equal(upgradeStore(location).version, 13);
  const upgraded = new DatabaseSync(database_path, { readOnly: true }); const fresh = new DatabaseSync(':memory:'); fresh.exec(SCHEMA_SQL);
  try { assert.deepEqual(upgraded.prepare(schema).all(), fresh.prepare(schema).all()); } finally { upgraded.close(); fresh.close(); }
  const store = openStore(location);
  try {
    const run = (value: Record<string, unknown>) => executeOperation(store.db, parseOperation(value), 'test:owner');
    await run({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'upgrade', body: 'Preview' });
    assert.deepEqual(await run({ op: 'resource_add', issue_id: 'pd-1', kind: 'worker', name: 'preview-api', expected_revision: 1, request_id: crypto.randomUUID() }),
      { resource_receipt: { issue_id: 'pd-1', seq: 1, revision: 2, outcome: 'added' } });
  } finally { store.close(); }
});

test('the CLI records and marks resources, and a refused close lists the entries that remain', t => {
  const { root, location } = localStore(t);
  const executable = new URL('../src/cli.ts', import.meta.url).pathname;
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(root, 'config') };
  for (const name of ['POLYLINEDB_ACTOR', 'POLYLINEDB_ACTOR_KIND', 'POLYLINEDB_DATA_DIR', 'POLYLINEDB_CONNECTION', 'POLYLINEDB_SESSION_ID']) delete env[name];
  const spawn = (args: string[]) => spawnSync(process.execPath, [executable, '--data-dir', location.directory, '--actor', 'local:test', '--prefix', 'pd', ...args], { cwd: location.cwd, env, encoding: 'utf8' });
  const pd = (args: string[]) => { const result = spawn(args); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
  pd(['create', '--tool', 'test', '--project', 'cli', '--body', 'Preview']);
  assert.deepEqual(pd(['resource', 'add', '1', '--kind', 'worker', '--name', 'preview-api', '--expected-revision', '1']), { resource_receipt: { issue_id: 'pd-1', seq: 1, revision: 2, outcome: 'added' } });
  assert.deepEqual(pd(['resource', 'update', '1', '--seq', '1', '--external-id', 'api-1', '--mark', 'created', '--expected-revision', '2']), { resource_receipt: { issue_id: 'pd-1', seq: 1, revision: 3, outcome: 'updated' } });
  const listed = pd(['resource', 'list', '1']);
  assert.deepEqual([listed.revision, listed.resources.map((entry: { kind: string; name: string; external_id: string; state: string }) => [entry.kind, entry.name, entry.external_id, entry.state])], [3, [['worker', 'preview-api', 'api-1', 'created']]]);
  assert.deepEqual(pd(['resource', 'live', '--project', 'cli']), { entries: [{ issue: { id: 'pd-1', project: 'cli', status: 'open' }, resources: listed.resources }], next_cursor: null });

  const refused = spawn(['close', '1', '--expected', '1']);
  assert.equal(refused.status, 4);
  assert.deepEqual(JSON.parse(refused.stderr), { error: { code: 'resources_remaining', message: 'The issue still has external resources that are not verified deleted: worker:preview-api. Mark each one verified_deleted with resource_update, or close with resources_reason.',
    details: { resources: listed.resources } } });
  const usage = spawn(['resource', 'update', '1', '--seq', '1', '--mark', 'verified_deleted', '--evidence', 'gone', '--expected-revision', '3']);
  assert.equal(usage.status, 2);
  assert.equal(pd(['close', '1', '--expected', '1', '--resources-reason', 'kept for the demo']).issue.status, 'closed');
  assert.deepEqual(pd(['show', '1']).comments.map((comment: { body: string }) => comment.body), ['kept for the demo']);
});
