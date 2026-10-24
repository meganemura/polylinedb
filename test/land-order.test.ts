// Exercises land order on SQLite: the shared flow, and the property that land order never changes readiness or close decisions.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { node } from 'solarsql/node';
import * as hegel from '@hegeldev/hegel';
import * as gs from '@hegeldev/hegel/generators';
import { initializeStore, openStore, upgradeStore } from '../src/local-store/index.ts';
import { executeOperation, parseOperation } from '../src/records/index.ts';
import type { Actor } from '../src/records/index.ts';
import { SCHEMA_SQL, SCHEMA_V8_SQL, canonicalSnapshot, convertSnapshotV6, parseSnapshot } from '../src/records/persistence.ts';
import type { SqlExecutor } from '../src/records/persistence.ts';
import { runLandOrderFlow } from './fixtures/land-order-flow.ts';
import { downgradeToSchema8 } from './fixtures/legacy-schema.ts';

const propertyCases = Number(process.env.PD_HEGEL_CASES ?? 100);

test('land order on SQLite: receipts, replays, conflicts, cycles across both edge kinds, feed, handoff warnings, and the agent gate', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pd-land-order-'));
  const location = { directory: join(root, 'store'), cwd: join(root, 'work') };
  initializeStore(location); const store = openStore(location);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  await runLandOrderFlow((value, caller = 'test:owner') => executeOperation(store.db, parseOperation(value), caller), 'test:owner');
});

function memoryStore(): { db: SqlExecutor; close(): void } {
  const database = new DatabaseSync(':memory:'); database.exec(SCHEMA_SQL);
  return { close: () => database.close(), db: { reads: node(database), async batch(statements) {
    database.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(({ sql, params }) => ({ rows: database.prepare(sql).all(...params) })); database.exec('COMMIT'); return results; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  } } };
}

const statuses = ['open', 'deferred', 'closed'] as const;
test('property: land-order edges never change the ready and blocked worklists or a close decision', async () => {
  await hegel.testAsync(async tc => {
    const count = tc.draw(gs.integers({ minValue: 2, maxValue: 6 }));
    const issueStatuses = tc.draw(gs.arrays(gs.sampledFrom(statuses), { minSize: count, maxSize: count }));
    // Edges point from a later index to an earlier one, so neither kind alone or together can form a cycle.
    const pair = gs.tuples(gs.integers({ minValue: 0, maxValue: count - 1 }), gs.integers({ minValue: 0, maxValue: count - 1 }));
    const prerequisites = tc.draw(gs.arrays(pair, { maxSize: 6 })).filter(([a, b]) => a > b);
    const landOrder = tc.draw(gs.arrays(pair, { maxSize: 6 })).filter(([a, b]) => a > b);
    const observe = async (withLandOrder: boolean) => {
      const { db, close } = memoryStore();
      const run = (value: Record<string, unknown>, caller: string | Actor = 'test:owner') => executeOperation(db, parseOperation(value), caller);
      try {
        for (const status of issueStatuses) await run({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'property', body: 'Issue', status });
        const id = (index: number) => `pd-${index + 1}`;
        const revisions = new Map<string, number>();
        const edit = async (op: string, later: number, earlier: number) => {
          const key = `${op}:${id(later)}`; const expected = revisions.get(key) ?? 1;
          if (op === 'dependency_add') await run({ op, dependent_id: id(later), blocker_id: id(earlier), expected_revision: expected, request_id: crypto.randomUUID() });
          else await run({ op, later_id: id(later), earlier_id: id(earlier), expected_revision: expected, request_id: crypto.randomUUID() });
          revisions.set(key, expected + 1);
        };
        for (const [later, earlier] of prerequisites) await edit('dependency_add', later, earlier);
        if (withLandOrder) for (const [later, earlier] of landOrder) await edit('land_order_add', later, earlier);
        const worklist = async (state: 'ready' | 'blocked') => {
          const result = await run({ op: 'dependency_worklist', state, project: 'property' }); assert.ok('issues' in result);
          return result.issues.map(issue => issue.id);
        };
        const decisions = [];
        for (let index = 0; index < count; index++) {
          const shown = await run({ op: 'show', id: id(index) }); assert.ok('issue' in shown);
          try { await run({ op: 'close', id: id(index), expected: shown.issue.versions.status }); decisions.push('closed'); }
          catch (error) { decisions.push(error instanceof Error && 'code' in error ? String(error.code) : 'unknown'); }
        }
        return { ready: await worklist('ready'), blocked: await worklist('blocked'), decisions };
      } finally { close(); }
    };
    const before = await observe(false);
    const after = await observe(true);
    assert.deepEqual(after, before);
  }, { testCases: propertyCases, seed: 20261012, database: hegel.Database.fromPath('.hegel') });
});

function localStore(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pd-land-order-store-'));
  const location = { directory: join(root, 'store'), cwd: join(root, 'work') };
  mkdirSync(location.cwd);
  const { database_path } = initializeStore(location);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, location, database_path };
}

test('a land-order snapshot round-trips, a snapshot 6 converts with empty land order, and invalid land order is refused', async t => {
  const { location } = localStore(t);
  const source = openStore(location);
  let snapshot;
  try {
    const run = (value: Record<string, unknown>) => executeOperation(source.db, parseOperation(value), 'test:owner');
    for (const body of ['Later', 'Earlier']) await run({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'snapshot', body });
    const add = { op: 'land_order_add', later_id: 'pd-1', earlier_id: 'pd-2', expected_revision: 1, request_id: crypto.randomUUID() };
    await run(add);
    snapshot = source.exportSnapshot();
  } finally { source.close(); }
  assert.deepEqual([snapshot.version, snapshot.land_order, snapshot.land_order_revisions, snapshot.land_order_requests.map(row => [row.later_id, row.earlier_id, row.result_revision, row.outcome])],
    [9, [{ later_id: 'pd-1', earlier_id: 'pd-2' }], [{ later_id: 'pd-1', revision: 2 }], [['pd-1', 'pd-2', 2, 'added']]]);
  const restored = localStore(t); const target = openStore(restored.location);
  try {
    assert.deepEqual(target.importSnapshot(snapshot), { result: 'imported', issues: 2, comments: 0, memories: 0, dependencies: 0, dependency_revisions: 2, dependency_requests: 0, issue_claims: 0, claim_requests: 0,
      land_order: 1, land_order_requests: 1, issue_resources: 0, resource_requests: 0, stars: 0, sha256: target.importSnapshot(snapshot).sha256 });
    assert.equal(canonicalSnapshot(target.exportSnapshot()), canonicalSnapshot(snapshot));
    assert.deepEqual(await executeOperation(target.db, parseOperation({ op: 'land_order_list', issue_id: 'pd-2' }), 'test:owner'),
      { issue_id: 'pd-2', revision: 1, after: [], before: [{ id: 'pd-1', project: 'snapshot', status: 'open' }] });
  } finally { target.close(); }

  const { land_order: _edges, land_order_revisions: _revisions, land_order_requests: _requests, issue_resources: _entries, resource_revisions: _resourceRevisions, resource_requests: _resourceRequests, stars: _stars, ...rest } = snapshot;
  const converted = convertSnapshotV6({ ...rest, version: 6 });
  assert.deepEqual([converted.version, converted.land_order, converted.land_order_revisions, converted.land_order_requests], [9, [], [], []]);
  assert.throws(() => parseSnapshot({ ...rest, version: 6 }), { code: 'invalid_snapshot' });

  const refused = (change: Record<string, unknown>) => assert.throws(() => parseSnapshot({ ...snapshot, ...change }), { code: 'invalid_snapshot' }, JSON.stringify(change));
  refused({ land_order: [...snapshot.land_order, { later_id: 'pd-2', earlier_id: 'pd-1' }] });
  refused({ land_order: [{ later_id: 'pd-1', earlier_id: 'pd-1' }] });
  refused({ land_order: [{ later_id: 'pd-1', earlier_id: 'pd-9' }] });
  refused({ dependencies: [{ dependent_id: 'pd-2', blocker_id: 'pd-1' }] });
  refused({ land_order_revisions: [] });
  refused({ land_order_revisions: [{ later_id: 'pd-1', revision: 1 }] });
  refused({ land_order_requests: snapshot.land_order_requests.map(row => ({ ...row, outcome: 'removed' })) });
});

test('a schema 8 store upgrades to the canonical schema 9 DDL and then records land order', async t => {
  const { location, database_path } = localStore(t);
  const legacy = new DatabaseSync(database_path); downgradeToSchema8(legacy);
  const reference = new DatabaseSync(':memory:'); reference.exec(SCHEMA_V8_SQL);
  const schema = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
  try { assert.deepEqual(legacy.prepare(schema).all(), reference.prepare(schema).all()); } finally { legacy.close(); reference.close(); }
  assert.equal(upgradeStore(location).version, 11);
  const upgraded = new DatabaseSync(database_path, { readOnly: true }); const fresh = new DatabaseSync(':memory:'); fresh.exec(SCHEMA_SQL);
  try { assert.deepEqual(upgraded.prepare(schema).all(), fresh.prepare(schema).all()); } finally { upgraded.close(); fresh.close(); }
  const store = openStore(location);
  try {
    const run = (value: Record<string, unknown>) => executeOperation(store.db, parseOperation(value), 'test:owner');
    for (const body of ['Later', 'Earlier']) await run({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'upgrade', body });
    assert.deepEqual(await run({ op: 'land_order_add', later_id: 'pd-1', earlier_id: 'pd-2', expected_revision: 1, request_id: crypto.randomUUID() }),
      { land_order_receipt: { later_id: 'pd-1', earlier_id: 'pd-2', revision: 2, outcome: 'added' } });
  } finally { store.close(); }
});

test('the CLI adds, lists, and removes land order, and --human names what an issue lands after', t => {
  const { root, location } = localStore(t);
  const executable = new URL('../src/cli.ts', import.meta.url).pathname;
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(root, 'config') };
  for (const name of ['POLYLINEDB_ACTOR', 'POLYLINEDB_ACTOR_KIND', 'POLYLINEDB_DATA_DIR', 'POLYLINEDB_CONNECTION', 'POLYLINEDB_SESSION_ID']) delete env[name];
  const pd = (args: string[], raw = false) => {
    const result = spawnSync(process.execPath, [executable, '--data-dir', location.directory, '--actor', 'local:test', '--prefix', 'pd', ...args], { cwd: location.cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return raw ? result.stdout : JSON.parse(result.stdout);
  };
  for (const body of ['Later', 'Earlier']) pd(['create', '--tool', 'test', '--project', 'cli', '--body', body]);
  assert.deepEqual(pd(['land-order', 'add', '--later', '1', '--earlier', '2', '--expected-revision', '1']), { land_order_receipt: { later_id: 'pd-1', earlier_id: 'pd-2', revision: 2, outcome: 'added' } });
  assert.deepEqual(pd(['land-order', 'list', '1']), { issue_id: 'pd-1', revision: 2, after: [{ id: 'pd-2', project: 'cli', status: 'open' }], before: [] });
  assert.deepEqual(pd(['show', '1', '--with-land-order']).land_order, { issue_id: 'pd-1', revision: 2, after: [{ id: 'pd-2', project: 'cli', status: 'open' }], before: [] });
  assert.ok(String(pd(['show', '1', '--with-land-order', '--human'], true)).split('\n').includes('Lands after: pd-2 (open)'));
  assert.deepEqual(pd(['list', '--with-land-order']).land_order.map((order: { issue_id: string }) => order.issue_id), ['pd-1', 'pd-2']);
  assert.deepEqual(pd(['land-order', 'remove', '--later', '1', '--earlier', '2', '--expected-revision', '2']), { land_order_receipt: { later_id: 'pd-1', earlier_id: 'pd-2', revision: 3, outcome: 'removed' } });
});
