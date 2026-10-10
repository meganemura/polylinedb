// Tests Git metadata defaults and CLI initialization in disposable repositories and stores.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRepositoryDefaults, repositoryConfigPath, writeRepositoryDefaults } from "../src/workspace/local-config.ts";
import type { RepositoryDefaults } from "../src/workspace/local-config.ts";
import { PolylinedbError } from "../src/records/errors.ts";

function fixture(context: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pd-config-'));
  const repo = join(root, 'repo');
  const data = join(root, 'data');
  mkdirSync(repo);
  mkdirSync(data, { mode: 0o700 });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo]);
  const defaults: RepositoryDefaults = { version: 2, data_dir: realpathSync(data), tool: 'demo', project: 'demo', actor: 'local:owner', prefix: 'pd' };
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, repo, data, defaults, path: join(realpathSync(repo), '.git', 'polylinedb.json') };
}
function rejected(action: () => unknown) {
  assert.throws(action, error => error instanceof PolylinedbError && error.code === 'invalid_repository_config');
}

test('missing Git reports the prerequisite without selecting or creating a store', context => {
  const { root, repo } = fixture(context);
  const directory = join(root, 'new-store');
  for (const args of [['context'], ['init', '--data-dir', directory, '--tool', 'demo', '--project', 'demo', '--actor', 'local:owner']]) {
    const result = spawnSync(process.execPath, [new URL('../src/cli.ts', import.meta.url).pathname, ...args], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: join(root, 'without-git'), XDG_CONFIG_HOME: join(root, 'config') },
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), { error: { code: 'git_unavailable',
      message: 'Git must be installed and available on PATH to resolve repository defaults safely.' } });
  }
  assert.equal(existsSync(directory), false);
  assert.equal(existsSync(join(repo, '.git', 'polylinedb.json')), false);
});

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
  const moduleUrl = new URL("../src/workspace/local-config.ts", import.meta.url).href;
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
    'broken JSON', JSON.stringify({ ...defaults, unknown: true }), JSON.stringify({ ...defaults, version: 3 }),
    JSON.stringify({ version: 2, data_dir: defaults.data_dir }), JSON.stringify({ ...defaults, actor: '' }),
    JSON.stringify({ ...defaults, prefix: 'UpperCase' }), JSON.stringify({ ...defaults, prefix: 'with-dash' }),
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

test('old repository config explicitly requires recreation and is never silently upgraded', context => {
  const { repo, defaults, path } = fixture(context);
  const { prefix: _prefix, ...previous } = defaults;
  writeFileSync(path, JSON.stringify({ ...previous, version: 1 }), { mode: 0o600 });
  assert.throws(() => readRepositoryDefaults(repo), error => error instanceof PolylinedbError
    && error.code === 'invalid_repository_config' && /version 1.*recreate/.test(error.message));
  rejected(() => writeRepositoryDefaults(defaults, repo));
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1);
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
      cwd: repo, env: { ...process.env, XDG_CONFIG_HOME: join(root, 'config-home'), POLYLINEDB_CONNECTION: undefined, POLYLINEDB_DATA_DIR: '', POLYLINEDB_ACTOR: '' }, stdio: 'pipe',
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
      cwd: repo, env: { ...process.env, XDG_CONFIG_HOME: join(root, 'config-home'), POLYLINEDB_CONNECTION: undefined, POLYLINEDB_DATA_DIR: '', POLYLINEDB_ACTOR: '' }, encoding: 'utf8',
    });
    assert.equal(JSON.parse(output).database_path, join(realpathSync(data), 'polylinedb.sqlite'));
  }
});

test('named local create and list start Git once', context => {
  const { root, repo, data } = fixture(context);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(root, 'package.json'), '{ "type": "module" }\n');
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const log = process.env.PD_GIT_START_LOG;
if (log) appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n');
const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit', env: process.env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`);
  chmodSync(wrapper, 0o755);
  const cli = new URL('../src/cli.ts', import.meta.url).pathname;
  const environment: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    PATH: `${bin}:${process.env.PATH ?? ''}` };
  for (const name of ['POLYLINEDB_CONNECTION', 'POLYLINEDB_DATA_DIR', 'POLYLINEDB_ACTOR', 'POLYLINEDB_ACTOR_KIND', 'POLYLINEDB_SESSION_ID']) delete environment[name];
  for (const name of Object.keys(environment)) if (name.startsWith('GIT_')) delete environment[name];
  const invoke = (args: string[], cwd: string, log?: string) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd, env: log === undefined ? { ...environment, PATH: process.env.PATH } : { ...environment, PD_GIT_START_LOG: log }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout) as { issue?: { id: string }; issues?: { id: string }[] };
  };
  invoke(['connection', 'add', 'home', '--data-dir', data], repo);
  invoke(['init', '--connection', 'home', '--tool', 'demo', '--project', 'demo', '--actor', 'local:owner', '--prefix', 'pd'], repo);
  const starts = (name: string, args: string[], cwd: string) => {
    const log = join(root, `${name}.log`);
    const body = invoke(args, cwd, log);
    return { body, starts: readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) };
  };
  const revParse = (directory: string) => ['-C', directory, 'rev-parse', '--is-inside-work-tree', '--show-toplevel', '--git-common-dir'];
  const created = starts('create', ['--connection', 'home', 'create', '--tool', 'demo', '--project', 'demo', '--body', 'Synthetic issue', '--actor', 'local:owner'], repo);
  assert.deepEqual(created.starts, [revParse(realpathSync(repo))]);
  const listed = starts('list', ['--connection', 'home', 'list', '--actor', 'local:owner'], repo);
  assert.deepEqual(listed.starts, [revParse(realpathSync(repo))]);
  assert.equal(listed.body.issues?.[0]?.id, created.body.issue?.id);
  const away = starts('outside', ['--connection', 'home', 'list', '--actor', 'local:owner'], outside);
  assert.deepEqual(away.starts, [revParse(realpathSync(outside))]);
  assert.equal(away.body.issues?.[0]?.id, created.body.issue?.id);
});

test('a failed Git start is not reused and another directory keeps its own answer', context => {
  const { root, repo, path } = fixture(context);
  const saved = process.env.PATH;
  process.env.PATH = join(root, 'without-git');
  try {
    assert.throws(() => readRepositoryDefaults(repo), error => error instanceof PolylinedbError && error.code === 'git_unavailable');
    assert.throws(() => repositoryConfigPath(repo), error => error instanceof PolylinedbError && error.code === 'git_unavailable');
  } finally { process.env.PATH = saved; }
  assert.equal(repositoryConfigPath(repo), path);
  assert.equal(repositoryConfigPath(root), undefined);
  assert.equal(repositoryConfigPath(repo), path);
});
