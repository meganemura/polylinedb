// Checks cross-session memory through CLI processes, with private stores outside the checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('CLI retrieves a prior session fact, detects conflicts, and preserves it through export/import', t => {
  const root = mkdtempSync(join(tmpdir(), 'pd-memory-cli-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'work'); mkdirSync(cwd);
  const source = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(root, 'config') };
  delete env.POLYLINEDB_CONNECTION; delete env.POLYLINEDB_DATA_DIR; delete env.POLYLINEDB_ACTOR; delete env.POLYLINEDB_ACTOR_KIND;
  const run = (args: string[], status = 0, directory = join(root, 'store')) => {
    const result = spawnSync(process.execPath, [source, '--data-dir', directory, '--actor', 'test:cli', ...args], { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, status, result.stderr);
    return JSON.parse(status === 0 ? result.stdout : result.stderr);
  };
  run(['init']);
  const request = ['memory', 'create', '--project', 'demo', '--title', 'Test command', '--body', 'Run npm test.', '--request-id', 'e9bb3952-0a22-49f1-b892-7a89a36ff3d7'];
  assert.equal(run(request).memory.id, 'pd-m1');
  assert.equal(run(['memory', 'context', '--project', 'demo']).memories[0].body, 'Run npm test.');
  const observed = run(['memory', 'context', '--project', 'demo', '--with-revision']).memory_revision;
  assert.equal(typeof observed, 'string');
  assert.deepEqual(run(['list', '--project', 'demo', '--observed-memory-revision', observed]).memory_freshness, { status: 'current', project: 'demo' });
  assert.equal(run(['memory', 'show', 'm1', '--project', 'demo']).memory.version, 1);
  assert.deepEqual(run(['memory', 'show', '1', '--project', 'other'], 3).error, {
    code: 'memory_not_found', message: 'Memory not found in this project',
    details: { id: 'pd-m1', project: 'other', prefix: 'pd', prefix_source: 'builtin' },
  });
  assert.deepEqual(run(['memory', 'show', 'm2', '--project', 'demo'], 3).error, {
    code: 'memory_not_found', message: 'Memory not found in this project',
    details: { id: 'pd-m2', project: 'demo', prefix: 'pd', prefix_source: 'builtin' },
  });
  assert.deepEqual(run(['memory', 'show', 'pd-m3', '--project', 'demo'], 3).error, {
    code: 'memory_not_found', message: 'Memory not found in this project', details: { id: 'pd-m3', project: 'demo' },
  });
  assert.equal(run(['memory', 'update', '1', '--project', 'demo', '--title', 'Test command', '--body', 'Run npm test twice.', '--expected', '1']).memory.version, 2);
  assert.deepEqual(run(['list', '--project', 'demo', '--observed-memory-revision', observed]).memory_freshness, { status: 'stale', project: 'demo', reason: 'memory_changed' });
  assert.equal(run(['memory', 'delete', '1', '--project', 'demo', '--expected', '1'], 4).error.code, 'memory_conflict');
  const snapshot = join(root, 'snapshot.json'); run(['export', '--file', snapshot]);
  const restored = join(root, 'restored'); run(['init'], 0, restored); run(['import', '--file', snapshot], 0, restored);
  assert.equal(run(['memory', 'search', 'twice', '--project', 'demo'], 0, restored).memories[0].version, 2);
  assert.equal(run(['memory', 'context', '--project', 'demo'], 0, restored).store.database_path, join(restored, 'polylinedb.sqlite'));
  assert.equal(run(['memory', 'list'], 2).error.code, 'invalid_input');
  assert.deepEqual(readdirSync(cwd), []);
  const v2 = join(root, 'v2.json');
  writeFileSync(v2, JSON.stringify({ format: 'polylinedb.snapshot', version: 2, issues: [], comments: [], counters: [], requests: [] }));
  const converted = spawnSync(process.execPath, [source, 'snapshot', 'convert', '--file', v2], { cwd, env, encoding: 'utf8' });
  assert.equal(converted.status, 0, converted.stderr);
  assert.deepEqual(JSON.parse(converted.stdout).memories, []);
  assert.equal(JSON.parse(converted.stdout).version, 6);
});
