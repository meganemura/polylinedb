// Checks issue closure records in snapshots and historical recovery through public persistence entries.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { node } from 'solarsql/node';
import { exportHistoricalSnapshot } from '../src/local-store/index.ts';
import { executeOperation, parseOperation } from '../src/records/index.ts';
import { canonicalSnapshot, canonicalSnapshotV5, convertSnapshotV5, parseSnapshot, SCHEMA_V6_SQL } from '../src/records/persistence.ts';
import type { Snapshot, SqlExecutor } from '../src/records/persistence.ts';

const source = new URL('../src/cli.ts', import.meta.url).pathname;
const base = { tool: 'tool', project: 'project', body: 'body', type: 'task', priority: 2, labels: [],
  versions: { tool: 1, project: 1, body: 1, status: 2, type: 1, priority: 1, labels: 1 },
  created_at: '2026-01-02T03:04:05.000Z', created_by: 'author', updated_at: '2026-01-03T03:04:05.000Z', updated_by: 'editor' };
function snapshot(issues: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { format: 'polylinedb.snapshot', version: 6, issues, comments: [], counters: [{ scope: 'pd', last_number: 3 }], requests: [],
    memories: [], memory_counters: [], memory_requests: [], dependencies: [],
    dependency_revisions: issues.map(issue => ({ dependent_id: issue.id, revision: 1 })), dependency_requests: [], issue_claims: [], claim_requests: [] };
}
const closed = { ...base, id: 'pd-1', status: 'closed', closed_at: '2026-01-03T03:04:05.000Z', closed_by: 'closer' };
const legacyClosed = { ...base, id: 'pd-2', status: 'closed', closed_at: null, closed_by: null };
const open = { ...base, id: 'pd-3', status: 'open', closed_at: null, closed_by: null };
const withoutClosure = ({ closed_at: _at, closed_by: _by, ...issue }: Record<string, unknown>) => issue;
function root(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'pd-closure-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('snapshot 6 keeps a recorded closure and an empty closure on closed issues', () => {
  const parsed = parseSnapshot(snapshot([closed, legacyClosed, open]));
  assert.deepEqual(parsed.issues.map(issue => [issue.id, issue.closed_at, issue.closed_by]), [
    ['pd-1', '2026-01-03T03:04:05.000Z', 'closer'], ['pd-2', null, null], ['pd-3', null, null]]);
  assert.equal(canonicalSnapshot(parsed), JSON.stringify(parseSnapshot(JSON.parse(canonicalSnapshot(parsed)))));
});

test('snapshot 6 rejects a closure on an unclosed issue, a half closure, missing fields, and an invalid close time', () => {
  for (const issue of [
    { ...open, closed_at: '2026-01-03T03:04:05.000Z', closed_by: 'closer' },
    { ...closed, closed_by: null },
    { ...closed, closed_at: null },
    { ...closed, closed_at: 'yesterday' },
    { ...closed, closed_by: '' },
    withoutClosure(closed),
  ]) assert.throws(() => parseSnapshot(snapshot([issue])), { code: 'invalid_snapshot' }, JSON.stringify(issue));
});

test('snapshot 5 converts with empty closures and keeps its own canonical digest', () => {
  const legacy = { ...snapshot([withoutClosure(legacyClosed)]), version: 5 };
  assert.throws(() => parseSnapshot(legacy), { code: 'invalid_snapshot' });
  const converted: Snapshot = convertSnapshotV5(legacy);
  assert.equal(converted.version, 6);
  assert.deepEqual(converted.issues.map(issue => [issue.id, issue.status, issue.closed_at, issue.closed_by]), [['pd-2', 'closed', null, null]]);
  const canonical = JSON.parse(canonicalSnapshotV5(legacy));
  assert.equal(canonical.version, 5);
  assert.deepEqual(Object.keys(canonical.issues[0]).filter(key => key.startsWith('closed')), []);
});

test('the CLI converts snapshot 5 to snapshot 6 without touching a store', t => {
  const directory = root(t); const cwd = join(directory, 'work'); mkdirSync(cwd);
  const file = join(directory, 'v5.json');
  writeFileSync(file, JSON.stringify({ ...snapshot([withoutClosure(legacyClosed)]), version: 5 }));
  const converted = spawnSync(process.execPath, [source, 'snapshot', 'convert', '--from', '5', '--file', file], { cwd, encoding: 'utf8',
    env: { ...process.env, POLYLINEDB_DATA_DIR: undefined, POLYLINEDB_CONNECTION: undefined, XDG_CONFIG_HOME: join(directory, 'config') } });
  assert.equal(converted.status, 0, converted.stderr);
  const output = JSON.parse(converted.stdout);
  assert.equal(output.version, 6);
  assert.deepEqual(output.issues.map((issue: Record<string, unknown>) => [issue.closed_at, issue.closed_by]), [[null, null]]);
});

test('historical export of a schema 6 store keeps its claims and leaves closures empty', async t => {
  const parent = root(t); const directory = join(parent, 'store'); mkdirSync(directory, { mode: 0o700 }); mkdirSync(join(parent, 'work'));
  const path = join(directory, 'polylinedb.sqlite');
  const database = new DatabaseSync(path); database.exec(SCHEMA_V6_SQL);
  const db: SqlExecutor = { reads: node(database), batch: async statements => {
    database.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(({ sql, params }) => ({ rows: database.prepare(sql).all(...params) })); database.exec('COMMIT'); return results; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  } };
  const run = (input: unknown) => executeOperation(db, parseOperation(input), 'old:author');
  await run({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'tool', project: 'project', body: 'Claimed' });
  const inspection = await run({ op: 'claim_show', issue_id: 'pd-1' }); assert.ok('claim' in inspection);
  await run({ op: 'claim_acquire', issue_id: 'pd-1', incarnation: inspection.claim.store_incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID() });
  database.exec("UPDATE issues SET status = 'closed', status_v = 2 WHERE id = 'pd-1'");
  database.close(); chmodSync(path, 0o600);
  const recovered = exportHistoricalSnapshot({ directory, cwd: join(parent, 'work') });
  assert.equal(recovered.version, 6);
  assert.equal(recovered.issue_claims.length, 1);
  assert.equal(recovered.claim_requests.length, 1);
  assert.deepEqual(recovered.issues.map(issue => [issue.status, issue.closed_at, issue.closed_by]), [['closed', null, null]]);
});
