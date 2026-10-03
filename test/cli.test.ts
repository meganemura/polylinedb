// Subprocesses verify the executable contract against real persistent storage.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

const executable = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'polylinedb-cli-'));
  const cwd = join(root, 'work');
  const directory = join(root, 'store');
  mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function run(args: string[], options: { status?: number; input?: string; actor?: boolean } = {}) {
    const env = { ...process.env };
    delete env.POLYLINEDB_ACTOR;
    delete env.POLYLINEDB_DATA_DIR;
    const result = spawnSync(process.execPath, [executable, '--data-dir', directory, ...(options.actor === false ? [] : ['--actor', 'local:test']), ...args], {
      cwd, encoding: 'utf8', input: options.input,
      env,
    });
    assert.equal(result.status, options.status ?? 0, result.stderr);
    const output = result.status === 0 ? result.stdout : result.stderr;
    assert.equal(result.status === 0 ? result.stderr.replace(/^.*ExperimentalWarning.*\n(?:.*\n)?/gm, '') : result.stdout, '');
    return JSON.parse(output);
  }
  return { root, cwd, directory, run };
}

test('CLI persists issues, exposes conflicts, and appends comments', t => {
  const { run, cwd } = fixture(t);
  const initialized = run(['init']);
  assert.deepEqual(run(['init']), initialized);
  assert.deepEqual(readdirSync(cwd), []);
  const { issue } = run(['create', '--tool', 'codex', '--project', 'demo', '--body-file', '-', '--label', 'urgent', '--json'], { input: 'first body\n' });
  assert.equal(issue.body, 'first body\n');
  assert.equal(issue.created_by, 'local:test');
  assert.deepEqual(run(['show', issue.id]).issue, issue);
  const changed = run(['update', issue.id, '--body', 'new body', '--expect', 'body=1']).issue;
  assert.equal(changed.versions.body, 2);
  const stale = run(['update', issue.id, '--body', 'stale', '--expect', 'body=1'], { status: 4 });
  assert.equal(stale.error.code, 'conflict');
  assert.equal(run(['update', issue.id, '--priority', '0', '--expect', 'priority=1']).issue.priority, 0);
  const comment = run(['comment', issue.id, '--body', 'needle comment']).comment;
  assert.equal(comment.body, 'needle comment');
  assert.equal(run(['show', issue.id]).comments.length, 1);
  assert.equal(run(['search', 'needle']).issues[0].id, issue.id);
  assert.equal(run(['list', '--label', 'urgent', '--tool', 'codex']).issues.length, 1);
  assert.equal(run(['close', issue.id, '--expected', '1']).issue.status, 'closed');
  assert.equal(run(['reopen', issue.id, '--expected', '2']).issue.status, 'open');
  assert.equal(run(['show', '00000000-0000-0000-0000-000000000000'], { status: 3 }).error.code, 'not_found');
});

test('CLI rejects invalid arguments before creating storage and actor requires no store', t => {
  const { run, root, cwd } = fixture(t);
  assert.deepEqual(run(['actor'], { actor: false }), { actor: 'local:reader' });
  assert.equal(run(['create', '--tool', 'codex', '--project', 'demo', '--body', 'x'], { status: 2, actor: false }).error.code, 'invalid_input');
  for (const args of [
    ['init', '--unknown'], ['init', '--data-dir'], ['list', '--limit', '1', '--limit', '2'],
    ['show', 'one', 'two'], ['list', '--priority', '1.0'], ['list', '--priority', '-1'],
    ['update', 'id', '--body', 'x'], ['update', 'id', '--body', 'x', '--expect', 'boddy=1'],
    ['update', 'id', '--body', 'x', '--expect', 'body=1', '--expect', 'status=1'],
    ['create', '--tool', 'c', '--project', 'p', '--body', 'x', '--body-file', '-'],
  ]) assert.equal(run(args, { status: 2 }).error.code, 'invalid_input');
  assert.deepEqual(readdirSync(root), ['work']);
  assert.deepEqual(readdirSync(cwd), []);
});

test('CLI prevents repository and symlink storage paths', t => {
  const { root, cwd } = fixture(t);
  mkdirSync(join(cwd, '.git'));
  const alias = join(root, 'alias');
  symlinkSync(cwd, alias);
  for (const directory of [join(cwd, 'state'), join(alias, 'state')]) {
    const result = spawnSync(process.execPath, [executable, 'init', '--data-dir', directory], { cwd, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stderr).error.code, 'invalid_data_directory');
  }
  assert.deepEqual(readdirSync(cwd), ['.git']);
});

test('CLI treats dash queries and help option values as literal text', t => {
  const { run } = fixture(t);
  run(['init']);
  const compiler = run(['create', '--tool', 'codex', '--project', 'demo', '--body', 'Fix -Werror']).issue;
  const helpText = run(['create', '--tool', 'codex', '--project', 'demo', '--body', '--help']).issue;
  assert.equal(helpText.body, '--help');
  assert.deepEqual(run(['search', '--', '-Werror']).issues.map((issue: { id: string }) => issue.id), [compiler.id]);
  assert.deepEqual(run(['search', '--', '--help']).issues.map((issue: { id: string }) => issue.id), [helpText.id]);
  assert.equal(run(['update', helpText.id, '--body', '--help', '--expect', 'body=1']).issue.body, '--help');
  assert.equal(run(['comment', helpText.id, '--body', '--help']).comment.body, '--help');
});

test('help documents version expectations without initializing storage', t => {
  const { root, cwd, directory } = fixture(t);
  const result = spawnSync(process.execPath, [executable, '--data-dir', directory, '--help'], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--expected VERSION/);
  assert.match(result.stdout, /--expect FIELD=VERSION/);
  for (const args of [['search', '--help'], ['-h'], []]) {
    const helpResult = spawnSync(process.execPath, [executable, ...args], { cwd, encoding: 'utf8' });
    assert.equal(helpResult.status, 0);
    assert.equal(helpResult.stdout, result.stdout);
  }
  assert.deepEqual(readdirSync(root), ['work']);
});
