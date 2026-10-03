// Subprocesses verify the executable contract against real persistent storage.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';

const executable = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
function isolatedEnvironment(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(cwd, '..', 'config-home') };
  delete env.POLYLINEDB_ACTOR;
  delete env.POLYLINEDB_DATA_DIR;
  delete env.POLYLINEDB_CONNECTION;
  return env;
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'polylinedb-cli-'));
  const cwd = join(root, 'work');
  const directory = join(root, 'store');
  mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function run(args: string[], options: { status?: number; input?: string; actor?: boolean } = {}) {
    const env = isolatedEnvironment(cwd);
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
  assert.equal(run(['show', 'pd-999999'], { status: 3 }).error.code, 'not_found');
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
    const result = spawnSync(process.execPath, [executable, 'init', '--data-dir', directory], { cwd, env: isolatedEnvironment(cwd), encoding: 'utf8' });
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
  const result = spawnSync(process.execPath, [executable, '--data-dir', directory, '--help'], { cwd, env: isolatedEnvironment(cwd), encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--expected VERSION/);
  assert.match(result.stdout, /--expect FIELD=VERSION/);
  for (const args of [['search', '--help'], ['-h'], []]) {
    const helpResult = spawnSync(process.execPath, [executable, ...args], { cwd, env: isolatedEnvironment(cwd), encoding: 'utf8' });
    assert.equal(helpResult.status, 0);
    assert.equal(helpResult.stdout, result.stdout);
  }
  assert.deepEqual(readdirSync(root), ['work']);
});

function plainCli(cwd: string, args: string[], options: { status?: number; input?: string; env?: Record<string, string> } = {}) {
  const env = isolatedEnvironment(cwd);
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd, env: { ...env, ...options.env }, encoding: 'utf8', input: options.input,
  });
  assert.equal(result.status, options.status ?? 0, result.stderr);
  if (result.status === 0) assert.equal(result.stderr.replace(/^.*ExperimentalWarning.*\n(?:.*\n)?/gm, ''), '');
  else assert.equal(result.stdout, '');
  return JSON.parse(result.status === 0 ? result.stdout : result.stderr);
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('stealth init supplies external storage and defaults without changing Git status', t => {
  const { root, cwd } = fixture(t);
  git(cwd, ['init', '--quiet']);
  const before = git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  const env = { XDG_DATA_HOME: join(root, 'data-home') };
  const initialized = plainCli(cwd, ['init', '--stealth', '--tool', 'demo', '--project', 'demo', '--actor', 'local:owner'], { env });
  assert.ok(initialized.database_path.startsWith(join(realpathSync(root), 'data-home', 'polylinedb', 'stores') + '/'));
  assert.equal(initialized.config_path, join(realpathSync(cwd), '.git', 'polylinedb.json'));
  assert.equal(statSync(initialized.config_path).mode & 0o777, 0o600);
  const context = plainCli(cwd, ['context'], { env });
  assert.deepEqual(context, {
    mode: 'local', connection: null, source: 'repository',
    data_dir: initialized.database_path.slice(0, -'/polylinedb.sqlite'.length), database_path: initialized.database_path,
    actor: 'local:owner', tool: 'demo', project: 'demo', prefix: 'pd', config_path: initialized.config_path,
  });
  const { issue } = plainCli(cwd, ['create', '--body', 'Uses repository defaults'], { env });
  assert.equal(issue.tool, 'demo');
  assert.equal(issue.project, 'demo');
  assert.equal(issue.created_by, 'local:owner');
  const other = plainCli(cwd, ['create', '--tool', 'manual-tool', '--project', 'other-project', '--body', 'Explicit overrides'], { env }).issue;
  assert.equal(other.tool, 'manual-tool');
  assert.equal(other.project, 'other-project');
  assert.deepEqual(plainCli(cwd, ['list'], { env }).issues.map((row: { id: string }) => row.id).sort(), [issue.id, other.id].sort());
  assert.deepEqual(plainCli(cwd, ['init', '--stealth'], { env }), initialized);
  assert.equal(git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']), before);
  assert.deepEqual(readdirSync(cwd), ['.git']);
});

test('CLI flags override environment and environment overrides repository actor and store', t => {
  const { root, cwd, directory } = fixture(t);
  git(cwd, ['init', '--quiet']);
  plainCli(cwd, ['init', '--stealth', '--data-dir', directory, '--tool', 'repo-tool', '--project', 'repo-project', '--actor', 'local:repo']);
  const envDirectory = join(root, 'env-store');
  const flagDirectory = join(root, 'flag-store');
  const outside = join(root, 'outside');
  mkdirSync(outside);
  plainCli(outside, ['init', '--data-dir', envDirectory], { env: { XDG_CONFIG_HOME: join(root, 'config-home') } });
  plainCli(outside, ['init', '--data-dir', flagDirectory], { env: { XDG_CONFIG_HOME: join(root, 'config-home') } });
  const env = { POLYLINEDB_DATA_DIR: envDirectory, POLYLINEDB_ACTOR: 'local:env' };
  const environment = plainCli(cwd, ['create', '--body', 'Environment target'], { env }).issue;
  assert.equal(environment.created_by, 'local:env');
  const flagged = plainCli(cwd, ['--data-dir', flagDirectory, '--actor', 'local:flag', 'create', '--tool', 'flag-tool', '--project', 'flag-project', '--body', 'Explicit target'], { env }).issue;
  assert.equal(flagged.created_by, 'local:flag');
  assert.equal(flagged.tool, 'flag-tool');
  assert.equal(flagged.project, 'flag-project');
  assert.equal(plainCli(cwd, ['context'], { env }).data_dir, envDirectory);
  assert.equal(plainCli(cwd, ['context'], { env }).actor, 'local:env');
  assert.equal(plainCli(cwd, ['context', '--data-dir', flagDirectory, '--actor', 'local:flag'], { env }).actor, 'local:flag');
  assert.deepEqual(plainCli(cwd, ['list']).issues, []);
  assert.deepEqual(plainCli(cwd, ['list'], { env }).issues.map((row: { id: string }) => row.id), [environment.id]);
  assert.deepEqual(plainCli(cwd, ['list', '--data-dir', flagDirectory], { env }).issues.map((row: { id: string }) => row.id), [flagged.id]);
});

test('stealth init outside Git rejects before creating a database', t => {
  const { cwd, directory } = fixture(t);
  const result = plainCli(cwd, ['init', '--stealth', '--data-dir', directory, '--actor', 'local:owner', '--tool', 'tool', '--project', 'project'], { status: 2 });
  assert.equal(result.error.code, 'invalid_input');
  assert.equal(existsSync(directory), false);
});

test('CLI snapshot restores IDs, hierarchy, comments, audit and versions with safe rerun', t => {
  const { root, cwd, run } = fixture(t);
  run(['init']);
  const parent = run(['create', '--tool', 'tool', '--project', 'project', '--type', 'epic', '--body', 'Parent']).issue;
  const child = run(['create', '--tool', 'tool', '--project', 'project', '--parent', parent.id, '--body', 'Child', '--label', 'selected']).issue;
  run(['update', child.id, '--body', 'Revised child', '--expect', 'body=1']);
  run(['comment', child.id, '--body', 'Original comment']);
  const source = run(['export']);
  const destination = join(root, 'restored');
  const target = (args: string[], options: { status?: number; input?: string } = {}) => plainCli(cwd, ['--data-dir', destination, '--actor', 'local:restorer', ...args], options);
  target(['init']);
  const imported = target(['import', '--file', '-'], { input: JSON.stringify(source) });
  assert.equal(imported.result, 'imported');
  assert.equal(imported.issues, 2);
  assert.equal(imported.comments, 1);
  assert.deepEqual(target(['export']), source);
  const repeated = target(['import', '--file', '-'], { input: JSON.stringify(source) });
  assert.deepEqual(repeated, { ...imported, result: 'already_present' });
  assert.equal(target(['show', child.id]).comments[0].body, 'Original comment');
  assert.equal(target(['show', child.id]).issue.versions.body, 2);
  target(['update', child.id, '--priority', '0', '--expect', 'priority=1']);
  const changed = target(['export']);
  const rejected = target(['import', '--file', '-'], { input: JSON.stringify(source), status: 4 });
  assert.equal(rejected.error.code, 'destination_not_empty');
  assert.deepEqual(target(['export']), changed);
});

test('malformed and oversized CLI imports leave the initialized store unchanged', t => {
  const { root, run } = fixture(t);
  run(['init']);
  const before = run(['export']);
  const malformed = run(['import', '--file', '-'], { input: '{not JSON', status: 2 });
  assert.equal(malformed.error.code, 'invalid_input');
  assert.deepEqual(run(['export']), before);
  const invalid = run(['import', '--file', '-'], { input: JSON.stringify({ ...before, issues: [{ id: 'invalid' }] }), status: 2 });
  assert.equal(invalid.error.code, 'invalid_snapshot');
  assert.deepEqual(run(['export']), before);
  const oversizedFile = join(root, 'oversized.json');
  writeFileSync(oversizedFile, ' '.repeat(16 * 1024 * 1024 + 1));
  const oversized = run(['import', '--file', oversizedFile], { status: 2 });
  assert.equal(oversized.error.code, 'invalid_input');
  assert.deepEqual(run(['export']), before);
});

test('CLI file export is private and refuses to overwrite an existing snapshot', t => {
  const { root, run } = fixture(t);
  run(['init']);
  run(['create', '--tool', 'tool', '--project', 'project', '--body', 'Export body']);
  const file = join(root, 'snapshot.json');
  const receipt = run(['export', '--file', file]);
  assert.equal(receipt.file, file);
  assert.equal(receipt.issues, 1);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), run(['export']));
  const before = readFileSync(file);
  const refused = run(['export', '--file', file], { status: 1 });
  assert.equal(refused.error.code, 'internal_error');
  assert.deepEqual(readFileSync(file), before);
});

test('CLI sequential IDs support natural pagination, child aliases and explicit prefix overrides', t => {
  const { run } = fixture(t);
  run(['init']);
  const epic = run(['create', '--tool', 'tool', '--project', 'project', '--type', 'epic', '--body', 'Parent']).issue;
  assert.equal(epic.id, 'pd-1');
  const child = run(['create', '--tool', 'tool', '--project', 'project', '--parent', '1', '--body', 'Child']).issue;
  assert.equal(child.id, 'pd-1.1');
  assert.equal(run(['show', '1.1']).issue.id, child.id);
  assert.equal(run(['comment', '1.1', '--body', 'Numeric child']).comment.issue_id, child.id);
  assert.equal(run(['update', '1.1', '--priority', '0', '--expect', 'priority=1']).issue.priority, 0);
  assert.equal(run(['close', '1.1', '--expected', '1']).issue.status, 'closed');
  assert.equal(run(['reopen', '1.1', '--expected', '2']).issue.status, 'open');
  for (let number = 2; number <= 12; number += 1) {
    assert.equal(run(['create', '--tool', 'tool', '--project', 'project', '--body', `Root ${number}`]).issue.id, `pd-${number}`);
  }
  const page = run(['list', '--after', '9', '--limit', '3']);
  assert.deepEqual(page.issues.map((issue: { id: string }) => issue.id), ['pd-10', 'pd-11', 'pd-12']);
  const other = run(['--prefix', 'other', 'create', '--tool', 'tool', '--project', 'project', '--body', 'Other prefix']).issue;
  assert.equal(other.id, 'other-1');
  assert.equal(run(['show', '1', '--prefix', 'other']).issue.id, other.id);
  assert.equal(run(['show', 'pd-1', '--prefix', 'other']).issue.id, epic.id);
});

test('CLI create retries reuse a supplied request ID and automatic IDs create separate issues', t => {
  const { run } = fixture(t);
  run(['init']);
  const requestId = '93373171-1d3b-466c-a10f-bf4cc556d9d5';
  const command = ['create', '--tool', 'tool', '--project', 'project', '--body', 'Retry intent', '--request-id', requestId];
  const initial = run(command).issue;
  assert.equal(initial.id, 'pd-1');
  assert.equal(run(command).issue.id, initial.id);
  assert.equal(run(['list']).issues.length, 1);
  run([...command.slice(0, -4), '--body', 'Different intent', '--request-id', requestId], { status: 4 });
  assert.equal(run(['show', '1']).issue.body, 'Retry intent');
  const next = run(command.slice(0, -2)).issue;
  assert.equal(next.id, 'pd-2');
  assert.equal(run(command.slice(0, -2)).issue.id, 'pd-3');
  assert.equal(run(['create', '--tool', 'tool', '--project', 'project', '--body', 'Bad request', '--request-id', 'not-uuid'], { status: 2 }).error.code, 'invalid_input');
});

test('stealth prefix is persisted, shown by context and checked before storage creation', t => {
  const { root, cwd, directory } = fixture(t);
  git(cwd, ['init', '--quiet']);
  plainCli(cwd, ['init', '--stealth', '--data-dir', directory, '--prefix', 'mut', '--tool', 'tool', '--project', 'project', '--actor', 'local:owner']);
  assert.equal(plainCli(cwd, ['context']).prefix, 'mut');
  assert.equal(plainCli(cwd, ['create', '--body', 'Repository prefix']).issue.id, 'mut-1');
  assert.equal(plainCli(cwd, ['show', '1']).issue.id, 'mut-1');
  assert.equal(plainCli(cwd, ['create', '--prefix', 'pd', '--body', 'Override prefix']).issue.id, 'pd-1');
  const config = JSON.parse(readFileSync(join(cwd, '.git', 'polylinedb.json'), 'utf8'));
  assert.equal(config.version, 2);
  assert.equal(config.prefix, 'mut');
  for (const prefix of ['UPPER', 'with-dash', 'a'.repeat(17), '']) {
    const store = join(root, `invalid-${prefix || 'empty'}`);
    plainCli(cwd, ['init', '--data-dir', store, '--prefix', prefix], { status: 2 });
    assert.equal(existsSync(store), false);
  }
});
