// Tests Git metadata defaults and CLI initialization in disposable repositories and stores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRepositoryDefaults, repositoryConfigPath, writeRepositoryDefaults } from '../src/local-config.ts';
import type { RepositoryDefaults } from '../src/local-config.ts';
import { PolylinedbError } from '../src/issues.ts';

function fixture(context: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pd-config-'));
  const repo = join(root, 'repo');
  const data = join(root, 'data');
  mkdirSync(repo);
  mkdirSync(data, { mode: 0o700 });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo]);
  const defaults: RepositoryDefaults = { version: 1, data_dir: realpathSync(data), tool: 'demo', project: 'demo', actor: 'local:owner' };
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, repo, data, defaults, path: join(realpathSync(repo), '.git', 'polylinedb.json') };
}
function rejected(action: () => unknown) {
  assert.throws(action, error => error instanceof PolylinedbError && error.code === 'invalid_repository_config');
}

test('normal repository writes private metadata defaults and reads from subdirectories', context => {
  const { repo, defaults, path } = fixture(context);
  assert.equal(readRepositoryDefaults(repo), undefined);
  assert.equal(repositoryConfigPath(repo), path);
  assert.equal(writeRepositoryDefaults(defaults, repo), path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readRepositoryDefaults(repo), defaults);
  const nested = join(repo, 'src', 'nested');
  mkdirSync(nested, { recursive: true });
  assert.deepEqual(readRepositoryDefaults(nested), defaults);
  assert.deepEqual(readdirSync(repo), ['.git', 'src']);
});

test('non-repository returns no defaults and cannot install configuration', context => {
  const { root, defaults } = fixture(context);
  assert.equal(repositoryConfigPath(root), undefined);
  assert.equal(readRepositoryDefaults(root), undefined);
  rejected(() => writeRepositoryDefaults(defaults, root));
  assert.equal(existsSync(join(root, 'polylinedb.json')), false);
});

test('exclusive write is idempotent for equal values and refuses changed defaults', context => {
  const { repo, defaults, path } = fixture(context);
  writeRepositoryDefaults(defaults, repo);
  const before = readFileSync(path);
  const inode = statSync(path).ino;
  assert.equal(writeRepositoryDefaults(defaults, repo), path);
  rejected(() => writeRepositoryDefaults({ ...defaults, project: 'another' }, repo));
  assert.deepEqual(readFileSync(path), before);
  assert.equal(statSync(path).ino, inode);
  assert.equal(readdirSync(join(repo, '.git')).some(name => name.endsWith('.tmp')), false);
});

test('concurrent writers install one complete configuration and never overwrite the winner', async context => {
  const { repo, defaults, path } = fixture(context);
  const moduleUrl = new URL('../src/local-config.ts', import.meta.url).href;
  const run = promisify(execFile);
  const code = `import { writeRepositoryDefaults } from ${JSON.stringify(moduleUrl)};
    try { writeRepositoryDefaults(JSON.parse(process.argv[1]), process.argv[2]); }
    catch { process.exitCode = 1; }`;
  const outcomes = await Promise.allSettled(['first', 'second'].map(project => run(process.execPath, [
    '--input-type=module', '-e', code, JSON.stringify({ ...defaults, project }), repo,
  ])));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
  const actual = readRepositoryDefaults(repo);
  assert.ok(actual);
  assert.ok(actual.project === 'first' || actual.project === 'second');
  assert.deepEqual({ ...actual, project: defaults.project }, defaults);
  assert.equal(statSync(path).nlink, 1);
  assert.equal(readdirSync(join(repo, '.git')).some(name => name.endsWith('.tmp')), false);
});

test('linked worktree uses common metadata without a commit', context => {
  const { root, repo, defaults, path } = fixture(context);
  const linked = join(root, 'linked');
  execFileSync('git', ['-C', repo, 'worktree', 'add', '--orphan', '-b', 'linked', linked], { stdio: 'pipe' });
  assert.equal(repositoryConfigPath(linked), path);
  assert.equal(writeRepositoryDefaults(defaults, linked), path);
  assert.deepEqual(readRepositoryDefaults(repo), defaults);
  assert.deepEqual(readRepositoryDefaults(linked), defaults);
  assert.deepEqual(readdirSync(linked), ['.git']);
});

test('symlinked cwd and external data directory resolve to canonical paths', context => {
  const { root, repo, data, defaults, path } = fixture(context);
  const alias = join(root, 'repo-alias');
  const dataAlias = join(root, 'data-alias');
  symlinkSync(repo, alias);
  symlinkSync(data, dataAlias);
  assert.equal(repositoryConfigPath(alias), path);
  assert.equal(writeRepositoryDefaults({ ...defaults, data_dir: dataAlias }, alias), path);
  assert.deepEqual(readRepositoryDefaults(alias), defaults);
});

test('Git environment path overrides cannot redirect configuration to another repository', context => {
  const { root, repo, defaults, path } = fixture(context);
  const other = join(root, 'other');
  mkdirSync(other);
  execFileSync('git', ['init', '--quiet', other]);
  const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES', 'GIT_CONFIG_COUNT'];
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.GIT_DIR = join(other, '.git');
    process.env.GIT_COMMON_DIR = join(other, '.git');
    process.env.GIT_WORK_TREE = other;
    process.env.GIT_CEILING_DIRECTORIES = root;
    process.env.GIT_CONFIG_COUNT = '999999';
    assert.equal(writeRepositoryDefaults(defaults, repo), path);
    assert.deepEqual(readRepositoryDefaults(repo), defaults);
    assert.equal(existsSync(join(other, '.git', 'polylinedb.json')), false);
  } finally {
    for (const name of names) {
      if (prior[name] === undefined) delete process.env[name];
      else process.env[name] = prior[name];
    }
  }
});

test('read rejects malformed or unknown configuration without rewriting it', context => {
  const { repo, defaults, path } = fixture(context);
  const variants = [
    'broken JSON', JSON.stringify({ ...defaults, unknown: true }), JSON.stringify({ ...defaults, version: 2 }),
    JSON.stringify({ version: 1, data_dir: defaults.data_dir }), JSON.stringify({ ...defaults, actor: '' }),
    JSON.stringify({ ...defaults, project: 'line\nbreak' }), JSON.stringify({ ...defaults, tool: 'x'.repeat(257) }),
    JSON.stringify({ ...defaults, data_dir: 'relative' }),
    JSON.stringify({ ...defaults, data_dir: join(repo, 'data') }), ' '.repeat(16385),
  ];
  mkdirSync(join(repo, 'data'), { mode: 0o700 });
  for (const content of variants) {
    writeFileSync(path, content, { mode: 0o600 });
    chmodSync(path, 0o600);
    rejected(() => readRepositoryDefaults(repo));
    rejected(() => writeRepositoryDefaults(defaults, repo));
    assert.equal(readFileSync(path, 'utf8'), content);
  }
});

test('configuration links, directories and public file permissions fail closed', context => {
  const { root, repo, defaults, path } = fixture(context);
  const target = join(root, 'target.json');
  writeFileSync(target, JSON.stringify(defaults), { mode: 0o600 });
  symlinkSync(target, path);
  rejected(() => readRepositoryDefaults(repo));
  rejected(() => writeRepositoryDefaults(defaults, repo));
  assert.equal(readFileSync(target, 'utf8'), JSON.stringify(defaults));
  rmSync(path);
  mkdirSync(path);
  rejected(() => readRepositoryDefaults(repo));
  rmSync(path, { recursive: true });
  writeFileSync(path, JSON.stringify(defaults), { mode: 0o644 });
  chmodSync(path, 0o644);
  rejected(() => readRepositoryDefaults(repo));
});

test('external store requirement rejects repository, metadata, other repository and nonexistent paths', context => {
  const { root, repo, defaults, path } = fixture(context);
  const other = join(root, 'other-repo');
  mkdirSync(other);
  execFileSync('git', ['init', '--quiet', other]);
  for (const data_dir of [repo, join(repo, '.git'), other, join(root, 'missing'), 'relative', 'bad\u0000path']) {
    rejected(() => writeRepositoryDefaults({ ...defaults, data_dir }, repo));
    assert.equal(existsSync(path), false);
  }
});

test('CLI rejects separate Git metadata destinations before creating a database', context => {
  const root = mkdtempSync(join(tmpdir(), 'pd-config-preflight-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const metadata = join(root, 'metadata');
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', '--separate-git-dir', metadata, repo]);
  const alias = join(root, 'metadata-alias');
  symlinkSync(metadata, alias);
  const cli = new URL('../src/cli.ts', import.meta.url).pathname;
  for (const directory of [join(metadata, 'new', 'store'), join(alias, 'new', 'store')]) {
    assert.throws(() => execFileSync(process.execPath, [cli, '--data-dir', directory, 'init', '--stealth', '--tool', 'demo', '--project', 'demo', '--actor', 'local:test'], {
      cwd: repo, env: { ...process.env, POLYLINEDB_DATA_DIR: '', POLYLINEDB_ACTOR: '' }, stdio: 'pipe',
    }), error => error instanceof Error && 'stderr' in error && String(error.stderr).includes('invalid_repository_config'));
    assert.equal(existsSync(join(metadata, 'new')), false);
    assert.equal(existsSync(join(metadata, 'polylinedb.json')), false);
  }
});

test('CLI stealth initialization accepts canonical aliases on repeated invocation', context => {
  const { root, repo, data } = fixture(context);
  const alias = join(root, 'data-alias');
  symlinkSync(data, alias);
  const cli = new URL('../src/cli.ts', import.meta.url).pathname;
  for (const directory of [data, alias]) {
    const output = execFileSync(process.execPath, [cli, '--data-dir', directory, 'init', '--stealth', '--tool', 'demo', '--project', 'demo', '--actor', 'local:test'], {
      cwd: repo, env: { ...process.env, POLYLINEDB_DATA_DIR: '', POLYLINEDB_ACTOR: '' }, encoding: 'utf8',
    });
    assert.equal(JSON.parse(output).database_path, join(realpathSync(data), 'polylinedb.sqlite'));
  }
});
