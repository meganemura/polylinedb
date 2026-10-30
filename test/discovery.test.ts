// Discovery links on local SQLite: the shared flow, the schema 12 upgrade, the inverse rule as a property, and the snapshot 11 round trip.
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
import type { Actor } from '../src/records/index.ts';
import { SCHEMA_SQL, SCHEMA_V12_SQL, canonicalSnapshot, convertSnapshotV10, parseSnapshot } from '../src/records/persistence/persistence.ts';
import type { SqlExecutor } from '../src/records/persistence/persistence.ts';
import { checkSchema12Discovery, populateSchema12Discovery, runDiscoveryFlow } from './fixtures/discovery-flow.ts';

const propertyCases = Number(process.env.PD_HEGEL_CASES ?? 100);
assert.ok(Number.isSafeInteger(propertyCases) && propertyCases > 0);
const owner: Actor = { id: 'access:owner', kind: 'human' };

function root(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'pd-discovery-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function freshStore(t: test.TestContext) {
  const location = { directory: join(root(t), 'store') };
  initializeStore(location);
  const store = openStore(location);
  t.after(() => store.close());
  return store;
}

function executor(database: DatabaseSync): SqlExecutor {
  return { reads: node(database), batch: async statements => {
    database.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(({ sql, params }) => ({ rows: database.prepare(sql).all(...params) })); database.exec('COMMIT'); return results; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  } };
}

const shown = async (db: SqlExecutor, id: string) => {
  const result = await executeOperation(db, parseOperation({ op: 'show', id }), owner);
  assert.ok('discovered' in result);
  return { discovered_from: result.discovered_from, discovered: result.discovered };
};

test('discovery links on local SQLite: both directions, refusals, replays, and nothing held', async t => {
  await runDiscoveryFlow(freshStore(t).db);
});

test('a populated schema 12 store upgrades to schema 13 with no links and the canonical DDL, and links follow', async t => {
  const directory = join(root(t), 'populated'); mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, 'polylinedb.sqlite');
  const legacy = new DatabaseSync(path); legacy.exec(SCHEMA_V12_SQL);
  let populated: { id: string };
  try { populated = await populateSchema12Discovery(executor(legacy)); } finally { legacy.close(); }
  chmodSync(path, 0o600);
  assert.deepEqual(upgradeStore({ directory }), { result: 'upgraded', version: 13, database_path: path });
  const schema = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
  const upgraded = new DatabaseSync(path, { readOnly: true }); const fresh = new DatabaseSync(':memory:'); fresh.exec(SCHEMA_SQL);
  try { assert.deepEqual(upgraded.prepare(schema).all(), fresh.prepare(schema).all()); } finally { upgraded.close(); fresh.close(); }
  const store = openStore({ directory });
  try { await checkSchema12Discovery(store.db, populated); } finally { store.close(); }
});

test('property: every issue lists exactly the issues that name it as discovered_from, in issue order', async t => {
  const store = freshStore(t);
  let round = 0;
  await hegel.testAsync(async tc => {
    round += 1;
    const prefix = `p${round}`;
    const ids: string[] = [];
    const sources = new Map<string, string>();
    const count = tc.draw(gs.integers({ minValue: 1, maxValue: 8 }));
    for (let index = 0; index < count; index++) {
      const pick = ids.length === 0 ? -1 : tc.draw(gs.integers({ minValue: -1, maxValue: ids.length - 1 }));
      const source = pick < 0 ? undefined : ids[pick];
      const created = await executeOperation(store.db, parseOperation({ op: 'create', prefix, request_id: crypto.randomUUID(), tool: 'test', project: 'property', body: `Issue ${index}`,
        ...(source === undefined ? {} : { discovered_from: source }) }), owner);
      assert.ok('issue' in created);
      ids.push(created.issue.id);
      if (source !== undefined) sources.set(created.issue.id, source);
    }
    for (const id of ids) {
      assert.deepEqual(await shown(store.db, id), { discovered_from: sources.get(id) ?? null, discovered: ids.filter(other => sources.get(other) === id) });
    }
  }, { testCases: Math.min(propertyCases, 40), seed: 20261030, database: hegel.Database.fromPath('.hegel') });
});

test('snapshot 11 keeps every link through export and import, and a snapshot 10 converts with none', async t => {
  const source = freshStore(t);
  await runDiscoveryFlow(source.db);
  const exported = source.exportSnapshot();
  assert.equal(exported.version, 11);
  assert.deepEqual(exported.issue_discoveries, [{ issue_id: 'df-2', discovered_from: 'df-1' }, { issue_id: 'df-3', discovered_from: 'df-1' }, { issue_id: 'df-4', discovered_from: 'df-2' }]);
  const target = freshStore(t);
  const imported = target.importSnapshot(exported);
  assert.deepEqual([imported.result, imported.issue_discoveries], ['imported', 3]);
  assert.equal(canonicalSnapshot(target.exportSnapshot()), canonicalSnapshot(exported));
  assert.deepEqual(await shown(target.db, 'df-1'), { discovered_from: null, discovered: ['df-2', 'df-3'] });
  assert.deepEqual(await shown(target.db, 'df-2'), { discovered_from: 'df-1', discovered: ['df-4'] });
  const replay = exported.requests.find(request => request.issue_id === 'df-2');
  assert.ok(replay);
  const again = await executeOperation(target.db, parseOperation(JSON.parse(replay.payload)), { id: replay.actor, kind: 'agent' });
  assert.ok('issue' in again && again.issue.id === 'df-2', 'the imported request still replays with its link');

  const [first] = exported.issue_discoveries;
  assert.ok(first);
  for (const broken of [
    [{ ...first, discovered_from: 'df-99' }, ...exported.issue_discoveries.slice(1)],
    [{ ...first, discovered_from: first.issue_id }, ...exported.issue_discoveries.slice(1)],
    [first, first, ...exported.issue_discoveries.slice(1)],
    [{ ...first, discovered_from: 'df-3' }, ...exported.issue_discoveries.slice(1)],
    exported.issue_discoveries.slice(1),
  ]) assert.throws(() => parseSnapshot({ ...exported, issue_discoveries: broken }), { code: 'invalid_snapshot' }, JSON.stringify(broken));

  const { issue_discoveries: _discoveries, ...rest } = exported;
  const plain = freshStore(t);
  await executeOperation(plain.db, parseOperation({ op: 'create', prefix: 'df', request_id: crypto.randomUUID(), tool: 'test', project: 'discovery', body: 'No link' }), owner);
  const { issue_discoveries: _none, ...v10 } = { ...plain.exportSnapshot(), version: 10 };
  assert.throws(() => parseSnapshot(v10), { code: 'invalid_snapshot' });
  const converted = convertSnapshotV10(v10);
  assert.deepEqual([converted.version, converted.issue_discoveries], [11, []]);
  assert.throws(() => convertSnapshotV10({ ...rest, version: 10 }), { code: 'invalid_snapshot' }, 'a snapshot 10 cannot carry a create request that names a link');
});
