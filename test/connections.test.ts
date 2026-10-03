// Exercises named connections through private configuration files and the real CLI.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addConnection, connectionConfigDirectory, defaultConnection, readConnections, selectConnection } from '../src/connections.ts';
import { readRepositoryDefaults, useRepositoryConnection, writeRepositoryDefaults } from '../src/local-config.ts';
import { PolylinedbError } from '../src/issues.ts';

const executable = new URL('../src/cli.ts', import.meta.url).pathname;
function fixture(context: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pd-connections-')));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo]);
  const environment: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    POLYLINEDB_CONNECTION: undefined, POLYLINEDB_DATA_DIR: undefined, POLYLINEDB_ACTOR: undefined };
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (args: string[], options: { status?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}) => {
    const result = spawnSync(process.execPath, [executable, ...args], { cwd: options.cwd ?? repo,
      env: { ...environment, ...options.env }, encoding: 'utf8' });
    assert.equal(result.status, options.status ?? 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.status === 0 ? result.stderr : result.stdout, '');
    return JSON.parse(result.status === 0 ? result.stdout : result.stderr);
  };
  return { root, repo, environment, run };
}

test('connection files have private modes, canonical origins, immutable definitions, and an explicit default', context => {
  const { root, environment } = fixture(context);
  assert.deepEqual(readConnections(environment), { connections: [], defaultName: undefined });
  const local = addConnection('home', { kind: 'local', data_dir: join(root, 'store') }, environment);
  assert.deepEqual(addConnection('home', local.definition, environment), local);
  assert.throws(() => addConnection('home', { kind: 'local', data_dir: join(root, 'different') }, environment),
    error => error instanceof PolylinedbError && error.code === 'connection_conflict');
  addConnection('cloud', { kind: 'cloud', url: 'https://ISSUES.example.invalid:443/' }, environment);
  defaultConnection('cloud', environment);
  defaultConnection('cloud', environment);
  const directory = connectionConfigDirectory(environment);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, 'connections')).mode & 0o777, 0o700);
  assert.equal(statSync(join(directory, 'connections', 'home.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(directory, 'default.json')).mode & 0o777, 0o600);
  assert.deepEqual(readConnections(environment), { connections: [
    { name: 'cloud', definition: { kind: 'cloud', url: 'https://issues.example.invalid' } }, local,
  ], defaultName: 'cloud' });
  assert.equal(existsSync(join(root, 'store')), false);
});

test('connection names, directories, HTTPS origins, and configuration shapes validate at the boundary', context => {
  const { root, environment } = fixture(context);
  for (const name of ['../other', 'UPPER', '', 'a'.repeat(65)]) {
    assert.throws(() => addConnection(name, { kind: 'local', data_dir: root }, environment), PolylinedbError);
  }
  for (const url of ['http://issues.example.invalid', 'https://user@issues.example.invalid', 'https://issues.example.invalid/path',
    'https://issues.example.invalid?x=1', 'https://issues.example.invalid#', 'https://issues.example.invalid?', ' https://issues.example.invalid']) {
    assert.throws(() => addConnection('cloud', { kind: 'cloud', url }, environment), PolylinedbError);
  }
  assert.throws(() => addConnection('home', { kind: 'local', data_dir: 'relative' }, environment), PolylinedbError);
  assert.throws(() => readConnections({ XDG_CONFIG_HOME: 'relative' }), PolylinedbError);
  addConnection('home', { kind: 'local', data_dir: join(root, 'store') }, environment);
  const path = join(connectionConfigDirectory(environment), 'connections', 'home.json');
  for (const value of [{ version: 1, definition: { kind: 'local', data_dir: root, url: 'https://issues.example.invalid' } },
    { version: 2, definition: { kind: 'local', data_dir: root } }, { version: 1, definition: { kind: 'local', data_dir: root }, extra: true }]) {
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    assert.throws(() => readConnections(environment), PolylinedbError);
  }
  writeFileSync(path, ' '.repeat(16385));
  assert.throws(() => readConnections(environment), PolylinedbError);
  writeFileSync(path, Buffer.from([0xff]));
  assert.throws(() => readConnections(environment), PolylinedbError);
});

test('configuration rejects symlink files, managed directories, and permissive modes', context => {
  const { root, environment } = fixture(context);
  addConnection('home', { kind: 'local', data_dir: join(root, 'store') }, environment);
  const directory = connectionConfigDirectory(environment);
  const path = join(directory, 'connections', 'home.json');
  chmodSync(path, 0o644);
  assert.throws(() => readConnections(environment), PolylinedbError);
  chmodSync(path, 0o600);
  const target = join(root, 'target.json');
  writeFileSync(target, readFileSync(path), { mode: 0o600 });
  rmSync(path);
  symlinkSync(target, path);
  assert.throws(() => readConnections(environment), PolylinedbError);
  rmSync(path);
  chmodSync(directory, 0o755);
  assert.throws(() => readConnections(environment), PolylinedbError);
  chmodSync(directory, 0o700);
  const alias = join(root, 'config-alias');
  symlinkSync(environment.XDG_CONFIG_HOME ?? '', alias);
  assert.throws(() => readConnections({ XDG_CONFIG_HOME: alias }), PolylinedbError);
});

test('selection respects whole-connection precedence and rejects conflicts at the selected tier', context => {
  const { root, environment } = fixture(context);
  addConnection('home', { kind: 'local', data_dir: join(root, 'store') }, environment);
  addConnection('cloud', { kind: 'cloud', url: 'https://issues.example.invalid' }, environment);
  const current = readConnections(environment);
  const base = { connection: undefined, directory: undefined, environment: {}, repository: undefined,
    ...current, fallbackDirectory: join(root, 'legacy') };
  assert.equal(selectConnection(base).source, 'legacy_default');
  assert.equal(selectConnection({ ...base, defaultName: 'home' }).source, 'user_default');
  const repository = { version: 3 as const, connection: 'home', tool: 'tool', project: 'demo', prefix: 'dm' };
  assert.equal(selectConnection({ ...base, repository, defaultName: 'cloud' }).source, 'repository');
  assert.equal(selectConnection({ ...base, repository, environment: { POLYLINEDB_CONNECTION: 'cloud' } }).kind, 'cloud');
  assert.deepEqual(selectConnection({ ...base, repository, connection: 'cloud', environment: {
    POLYLINEDB_CONNECTION: 'home', POLYLINEDB_DATA_DIR: join(root, 'env'),
  } }), { kind: 'cloud', name: 'cloud', url: 'https://issues.example.invalid', source: 'flag' });
  assert.equal(selectConnection({ ...base, directory: join(root, 'explicit'), environment: { POLYLINEDB_CONNECTION: 'cloud' } }).kind, 'local');
  assert.throws(() => selectConnection({ ...base, connection: 'cloud', directory: root }), PolylinedbError);
  assert.throws(() => selectConnection({ ...base, environment: { POLYLINEDB_CONNECTION: 'cloud', POLYLINEDB_DATA_DIR: root } }), PolylinedbError);
  assert.throws(() => selectConnection({ ...base, connection: 'unknown' }), error => error instanceof PolylinedbError && error.code === 'unknown_connection');
});

test('default Git initialization persists v2 context, reruns safely, and leaves worktree files unchanged', context => {
  const { root, repo, run } = fixture(context);
  const initialized = run(['init', '--tool', 'tool', '--project', 'demo', '--actor', 'local:owner', '--prefix', 'dm']);
  assert.deepEqual(run(['init']), initialized);
  assert.equal(readRepositoryDefaults(repo)?.version, 2);
  assert.deepEqual(readdirSync(repo), ['.git']);
  assert.equal(run(['context']).source, 'repository');
  assert.equal(run(['create', '--body', 'Default initialization']).issue.id, 'dm-1');
  assert.equal(run(['init', '--project', 'changed'], { status: 4 }).error.code, 'local_defaults_conflict');
  run(['init', '--data-dir', join(root, 'another'), '--tool', 'other', '--project', 'other', '--actor', 'local:other'], { status: 4 });
  assert.equal(existsSync(join(root, 'another')), false);
});

test('named init, explicit use, defaults, and worktrees retain repository context without moving issue data', context => {
  const { root, repo, run } = fixture(context);
  const directory = join(root, 'home-store');
  run(['connection', 'add', 'home', '--data-dir', directory]);
  run(['connection', 'add', 'cloud', '--url', 'https://issues.example.invalid']);
  const initialized = run(['init', '--connection', 'home', '--tool', 'tool', '--project', 'demo', '--actor', 'local:owner', '--prefix', 'dm']);
  assert.equal(readRepositoryDefaults(repo)?.version, 3);
  assert.deepEqual(run(['init']), initialized);
  const issue = run(['create', '--body', 'Retained local issue']).issue;
  run(['connection', 'use', 'cloud']);
  assert.deepEqual(run(['context']), { mode: 'cloud', connection: 'cloud', source: 'repository',
    url: 'https://issues.example.invalid', actor_source: 'authenticated', tool: 'tool', project: 'demo', prefix: 'dm', config_path: initialized.config_path });
  run(['connection', 'use', 'home']);
  assert.equal(run(['show', '1']).issue.id, issue.id);
  assert.equal(run(['actor']).actor, 'local:owner');
  run(['connection', 'default', 'cloud']);
  assert.equal(run(['context'], { cwd: root }).connection, 'cloud');
  assert.equal(run(['context']).connection, 'home');
  assert.deepEqual(run(['connection', 'list']).connections.map((row: { name: string; default: boolean }) => [row.name, row.default]), [['cloud', true], ['home', false]]);
  const linked = join(root, 'linked');
  execFileSync('git', ['-C', repo, 'worktree', 'add', '--orphan', '-b', 'linked', linked], { stdio: 'pipe' });
  assert.deepEqual(run(['context'], { cwd: linked }), run(['context']));
  run(['connection', 'use', 'cloud'], { cwd: linked });
  assert.equal(run(['context']).connection, 'cloud');
  assert.deepEqual(readdirSync(linked), ['.git']);
});

test('v2 context remains unchanged until explicit connection use converts its non-secret defaults', context => {
  const { root, repo, run } = fixture(context);
  const initialized = run(['init', '--tool', 'tool', '--project', 'demo', '--actor', 'local:owner', '--prefix', 'dm']);
  const before = readFileSync(initialized.config_path);
  run(['connection', 'add', 'cloud', '--url', 'https://issues.example.invalid']);
  run(['context', '--connection', 'cloud']);
  assert.deepEqual(readFileSync(initialized.config_path), before);
  run(['connection', 'use', 'cloud']);
  assert.deepEqual(readRepositoryDefaults(repo), { version: 3, connection: 'cloud', tool: 'tool', project: 'demo', prefix: 'dm', actor: 'local:owner' });
  assert.equal(existsSync(initialized.database_path), true);
  assert.equal(run(['context'], { cwd: root, status: 0 }).mode, 'local');
});

test('cloud init and unsupported commands never create local storage or read operation files', context => {
  const { root, repo, run } = fixture(context);
  run(['connection', 'add', 'cloud', '--url', 'https://issues.example.invalid']);
  const initialized = run(['init', '--connection', 'cloud', '--tool', 'tool', '--project', 'demo']);
  assert.deepEqual(run(['init']), initialized);
  assert.equal(initialized.mode, 'cloud');
  assert.equal(existsSync(join(root, 'data')), false);
  for (const args of [['actor'], ['list'], ['create', '--body-file', join(root, 'missing-body')],
    ['import', '--file', join(root, 'missing-snapshot')], ['export', '--file', join(root, 'export.json')]]) {
    assert.equal(run(args, { status: 2 }).error.code, 'cloud_not_supported');
  }
  assert.equal(existsSync(join(root, 'export.json')), false);
  assert.equal(existsSync(join(root, 'data')), false);
  assert.equal(run(['context'], { env: { POLYLINEDB_ACTOR: 'invalid\nactor' } }).actor_source, 'authenticated');
  assert.equal(run(['actor', '--actor', 'local:spoof'], { status: 2 }).error.code, 'invalid_input');
  run(['init', '--connection', 'cloud', '--tool', 'tool', '--project', 'demo'], { cwd: root, status: 2 });
  assert.deepEqual(readdirSync(repo), ['.git']);
});

test('real CLI rejects unknown names and conflicting selectors while explicit flags override environment selectors', context => {
  const { root, run } = fixture(context);
  run(['connection', 'add', 'cloud', '--url', 'https://issues.example.invalid']);
  assert.equal(run(['context', '--connection', 'unknown'], { status: 3 }).error.code, 'unknown_connection');
  run(['context', '--connection', 'cloud', '--data-dir', root], { status: 2 });
  run(['context'], { env: { POLYLINEDB_CONNECTION: 'cloud', POLYLINEDB_DATA_DIR: root }, status: 2 });
  assert.equal(run(['context', '--connection', 'cloud'], { env: { POLYLINEDB_CONNECTION: 'unknown', POLYLINEDB_DATA_DIR: root } }).mode, 'cloud');
  assert.equal(run(['context', '--data-dir', join(root, 'explicit')], { env: { POLYLINEDB_CONNECTION: 'cloud' } }).mode, 'local');
  run(['connection', 'use', 'cloud'], { status: 2 });
  run(['connection', 'add', 'bad', '--data-dir', root, '--url', 'https://issues.example.invalid'], { status: 2 });
});

test('configuration and selected local directories stay outside repository and separate Git metadata', context => {
  const { root, repo, run } = fixture(context);
  run(['connection', 'add', 'home', '--data-dir', join(root, 'store')], { env: { XDG_CONFIG_HOME: join(repo, 'config') }, status: 2 });
  assert.equal(existsSync(join(repo, 'config')), false);
  const separate = join(root, 'separate');
  const metadata = join(root, 'metadata');
  const outside = join(root, 'outside');
  mkdirSync(separate);
  mkdirSync(outside);
  execFileSync('git', ['init', '--quiet', '--separate-git-dir', metadata, separate]);
  run(['connection', 'add', 'unsafe', '--data-dir', join(metadata, 'store')], { cwd: outside });
  const outcome = run(['connection', 'use', 'unsafe'], { cwd: separate, status: 2 });
  assert.equal(outcome.error.code, 'invalid_repository_config');
  assert.equal(existsSync(join(metadata, 'polylinedb.json')), false);
  assert.equal(existsSync(join(metadata, 'store')), false);
});

test('concurrent independent definitions both persist and equal initializers converge', async context => {
  const { root, environment } = fixture(context);
  const run = promisify(execFile);
  const module = new URL('../src/connections.ts', import.meta.url).href;
  const code = `import { addConnection } from ${JSON.stringify(module)}; addConnection(process.argv[1], {kind:'cloud',url:'https://issues.example.invalid'});`;
  await Promise.all(['first', 'second', 'first'].map(name => run(process.execPath, ['--input-type=module', '-e', code, name], { env: environment })));
  assert.deepEqual(readConnections(environment).connections.map(row => row.name), ['first', 'second']);
  assert.equal(readdirSync(join(connectionConfigDirectory(environment), 'connections')).some(file => file.endsWith('.tmp')), false);
  assert.equal(existsSync(join(root, 'data')), false);
});

test('repository init and selection share a lock so an initial writer cannot overwrite an explicit selection', async context => {
  const { root, repo, environment } = fixture(context);
  const directory = join(root, 'store');
  mkdirSync(directory, { mode: 0o700 });
  const defaults = { version: 2 as const, data_dir: directory, tool: 'tool', project: 'demo', actor: 'local:owner', prefix: 'dm' };
  writeRepositoryDefaults(defaults, repo);
  const module = new URL('../src/local-config.ts', import.meta.url).href;
  const run = promisify(execFile);
  const code = `import { writeRepositoryDefaults, useRepositoryConnection } from ${JSON.stringify(module)};
    try { process.argv[1] === 'init' ? writeRepositoryDefaults(JSON.parse(process.argv[2]), process.argv[3]) : useRepositoryConnection('cloud',process.argv[3]); }
    catch { process.exitCode=1; }`;
  await Promise.allSettled(['init', 'use'].map(action => run(process.execPath,
    ['--input-type=module', '-e', code, action, JSON.stringify(defaults), repo], { env: environment })));
  assert.equal(readRepositoryDefaults(repo)?.version, 3);
  assert.equal(readdirSync(join(repo, '.git')).some(file => file.endsWith('.tmp') || file.endsWith('.lock')), false);
  assert.equal(useRepositoryConnection('cloud', repo), join(repo, '.git', 'polylinedb.json'));
});
