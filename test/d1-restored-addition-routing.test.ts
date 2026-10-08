// Exercises the routing steps of the restored-store addition against temporary Git repositories and private connection settings.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { AdditionRefused, restoredAddition, type RouteSwitches } from '../scripts/d1-restored-addition.ts';
import { addConnection, connectionConfigDirectory, defaultConnection, readConnections, readRepositoryDefaults, useRepositoryConnection, writeRepositoryDefaults } from '../src/workspace/index.ts';
import { localStore, privateDirectory, restoredDestination, sqliteBatch } from './fixtures/restored-addition.ts';

const workspaceSwitches: RouteSwitches = { repository: (connection, root) => { useRepositoryConnection(connection, root); }, userDefault: defaultConnection };

const selected = (root: string) => { const defaults = readRepositoryDefaults(root); return defaults?.version === 3 ? defaults.connection : undefined; };

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
}

/** A restored destination, a source, and three checkouts: a repository and its worktree on local defaults, and a repository on the named source connection. */
async function fixture(context: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pd-restored-routing-')));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { original, destination } = await restoredDestination(root);
  context.after(() => destination.close());
  const source = await localStore(root, 'source', 'src');
  source.store.close();
  const environment = { XDG_CONFIG_HOME: privateDirectory(root, 'config') };
  addConnection('cloud', { kind: 'cloud', url: 'https://issues.example.invalid' }, environment);
  addConnection('home', { kind: 'local', data_dir: dirname(source.path) }, environment);
  addConnection('other', { kind: 'local', data_dir: join(root, 'other') }, environment);
  defaultConnection('other', environment);
  const local = join(root, 'local');
  const worktree = join(root, 'local-worktree');
  const named = join(root, 'named');
  for (const repository of [local, named]) { mkdirSync(repository); git(repository, 'init', '--quiet', '--initial-branch=main'); git(repository, 'commit', '--quiet', '--allow-empty', '-m', 'init'); }
  git(local, 'worktree', 'add', '--quiet', worktree);
  writeRepositoryDefaults({ version: 2, data_dir: dirname(source.path), tool: 'fixture', project: 'local', actor: 'local-actor', prefix: 'loc' }, local);
  writeRepositoryDefaults({ version: 3, connection: 'home', tool: 'fixture', project: 'named', prefix: 'nam' }, named);
  let journals = 0;
  const journal = () => privateDirectory(root, `journal-${journals += 1}`);
  const owner = (directory: string, switches: RouteSwitches = workspaceSwitches) => restoredAddition(sqliteBatch(destination), directory, environment, switches);
  const input = { original, source: source.path };
  const run = (directory: string, switches: RouteSwitches = workspaceSwitches, repositories = [local, worktree, named]) =>
    owner(directory, switches).run({ ...input, connection: 'cloud', repositories });
  const resume = (directory: string) => owner(directory).resume();
  const retirement = () => {
    const database = new DatabaseSync(source.path);
    try { return database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'polylinedb_retired_%'").get()?.n; } finally { database.close(); }
  };
  return { root, environment, local, worktree, named, input, journal, owner, run, resume, retirement };
}

test('routing switches each repository default that selects the source, keeps its identity fields, and leaves an unrelated user default', async context => {
  const f = await fixture(context);
  const journal = f.journal();
  const result = await f.run(journal);
  assert.equal(result.outcome, 'routed');
  assert.equal(result.routes, 2, 'the worktree shares the configuration of its repository');
  assert.deepEqual(readRepositoryDefaults(f.local), { version: 3, connection: 'cloud', tool: 'fixture', project: 'local', prefix: 'loc', actor: 'local-actor' });
  assert.deepEqual(readRepositoryDefaults(f.worktree), readRepositoryDefaults(f.local));
  assert.deepEqual(readRepositoryDefaults(f.named), { version: 3, connection: 'cloud', tool: 'fixture', project: 'named', prefix: 'nam' });
  assert.equal(readConnections(f.environment).defaultName, 'other');
  assert.deepEqual(readdirSync(journal).filter(name => name.startsWith('route')).sort(), ['route-1.json', 'route-2.json', 'routed.json']);
  assert.deepEqual(await f.resume(journal), result);
});

test('a crash before or after each routing write resumes to the same routes', async context => {
  for (const after of [false, true]) for (const crashAt of [1, 2, 3]) {
    const f = await fixture(context);
    if (crashAt === 3) defaultConnection('home', f.environment);
    let writes = 0;
    const crashing: RouteSwitches = {
      repository(connection, root) {
        writes += 1;
        if (writes === crashAt && !after) throw new Error('crash');
        workspaceSwitches.repository(connection, root);
        if (writes === crashAt) throw new Error('crash');
      },
      userDefault(connection, environment) {
        writes += 1;
        if (writes === crashAt && !after) throw new Error('crash');
        workspaceSwitches.userDefault(connection, environment);
        if (writes === crashAt) throw new Error('crash');
      },
    };
    const journal = f.journal();
    const label = `${after ? 'after' : 'before'} write ${crashAt}`;
    await assert.rejects(f.run(journal, crashing), /crash/, label);
    assert.ok(!readdirSync(journal).includes('routed.json'), label);
    const result = await f.resume(journal);
    assert.equal(result.routes, crashAt === 3 ? 3 : 2, label);
    assert.equal(selected(f.local), 'cloud', label);
    assert.equal(selected(f.named), 'cloud', label);
    assert.equal(readConnections(f.environment).defaultName, crashAt === 3 ? 'cloud' : 'other', label);
  }
});

test('routing refuses to overwrite a setting changed after freezing, and a changed cloud connection', async context => {
  const f = await fixture(context);
  const stopped: RouteSwitches = { repository() { throw new Error('crash'); }, userDefault() { throw new Error('crash'); } };
  const journal = f.journal();
  await assert.rejects(f.run(journal, stopped), /crash/);
  useRepositoryConnection('other', f.named);
  await assert.rejects(f.resume(journal), (error: unknown) => error instanceof AdditionRefused && /Routing settings changed after freezing; routing waits/.test(error.message));
  assert.equal(selected(f.named), 'other');
  assert.equal(selected(f.local), 'cloud', 'the step before the changed setting completed and stays recorded');
  assert.deepEqual(readdirSync(journal).filter(name => name.startsWith('route')), ['route-1.json']);
  useRepositoryConnection('home', f.named);

  rmSync(join(connectionConfigDirectory(f.environment), 'connections', 'cloud.json'));
  addConnection('cloud', { kind: 'cloud', url: 'https://elsewhere.example.invalid' }, f.environment);
  await assert.rejects(f.resume(journal), (error: unknown) => error instanceof AdditionRefused && /cloud connection changed after freezing/.test(error.message));
  assert.equal(selected(f.named), 'home');
});

test('routing refuses before freezing when the target or a supplied repository does not fit, and leaves the source open', async context => {
  const f = await fixture(context);
  const refusals: [() => Promise<unknown>, RegExp][] = [
    [() => f.owner(f.journal()).run({ ...f.input, connection: 'home', repositories: [f.local] }), /The connection home must be a configured cloud connection/],
    [() => f.run(f.journal(), workspaceSwitches, [join(f.root, 'unconfigured')]), /Initialize repository defaults/],
    [() => f.run(f.journal(), workspaceSwitches, []), /No supplied repository and no user default selects the source store/],
  ];
  const elsewhere = join(f.root, 'elsewhere');
  mkdirSync(elsewhere);
  git(elsewhere, 'init', '--quiet', '--initial-branch=main');
  writeRepositoryDefaults({ version: 3, connection: 'other', tool: 'fixture', project: 'elsewhere', prefix: 'els' }, elsewhere);
  refusals.push([() => f.run(f.journal(), workspaceSwitches, [f.local, elsewhere]), /does not select the source store/]);
  mkdirSync(join(f.root, 'unconfigured'));
  git(join(f.root, 'unconfigured'), 'init', '--quiet', '--initial-branch=main');
  for (const [attempt, pattern] of refusals) await assert.rejects(attempt(), (error: unknown) => error instanceof Error && pattern.test(error.message), String(pattern));
  assert.equal(f.retirement(), 0);
  assert.equal(readRepositoryDefaults(f.local)?.version, 2);
});
