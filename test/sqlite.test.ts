// Exercises filesystem isolation, schema handling, and real transaction rollback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeStore, openStore } from '../src/sqlite.ts';
import { PolylinedbError, executeOperation, parseOperation } from '../src/issues.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'polylinedb-sqlite-'));
  const directory = join(root, 'store');
  const cwd = join(root, 'repo');
  mkdirSync(cwd);
  mkdirSync(join(cwd, '.git'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, directory, cwd };
}

test('init is idempotent and runtime leaves only one persistent database file', async (t) => {
  const location = fixture(t);
  const initialized = initializeStore(location);
  assert.equal(initialized.database_path, realpathSync(join(location.directory, 'polylinedb.sqlite')));
  const store = openStore(location);
  try {
    await executeOperation(store.db, parseOperation({ op: 'create', tool: 'x', project: 'y', body: 'persistent' }), 'alice');
  } finally { store.close(); }
  initializeStore(location);
  const reopened = openStore(location);
  try {
    const result = await executeOperation(reopened.db, parseOperation({ op: 'list' }), 'reader');
    assert.ok('issues' in result);
    assert.equal(result.issues[0]?.body, 'persistent');
  } finally { reopened.close(); }
  assert.deepEqual(readdirSync(location.directory), ['polylinedb.sqlite']);
  assert.deepEqual(readdirSync(location.cwd), ['.git']);
  assert.equal(statSync(location.directory).mode & 0o777, 0o700);
  assert.equal(statSync(initialized.database_path).mode & 0o777, 0o600);
});

test('runtime never initializes missing stores', (t) => {
  const location = fixture(t);
  assert.throws(() => openStore(location), (error: unknown) => error instanceof PolylinedbError && error.code === 'uninitialized_store');
  assert.equal(existsSync(location.directory), false);
});

test('paths inside the working directory or a repository are rejected before writes', (t) => {
  const { cwd, root } = fixture(t);
  for (const directory of [cwd, join(cwd, 'new', 'store'), 'relative-store']) {
    assert.throws(() => initializeStore({ directory, cwd }), (error: unknown) => error instanceof PolylinedbError && error.status === 400);
  }
  const nested = join(cwd, 'nested');
  mkdirSync(nested);
  assert.throws(() => initializeStore({ directory: join(cwd, 'sibling'), cwd: nested }), /outside/);
  const noGit = join(root, 'work');
  mkdirSync(noGit);
  assert.throws(() => initializeStore({ directory: join(noGit, 'store'), cwd: noGit }), /outside/);
  assert.deepEqual(readdirSync(cwd), ['.git', 'nested']);
  assert.deepEqual(readdirSync(noGit), []);
});

test('directory and database symlinks cannot bypass repository isolation', (t) => {
  const { cwd, root, directory } = fixture(t);
  const link = join(root, 'alias');
  symlinkSync(cwd, link);
  assert.throws(() => initializeStore({ directory: join(link, 'store'), cwd }), /outside/);
  assert.equal(existsSync(join(cwd, 'store')), false);
  mkdirSync(directory, { mode: 0o700 });
  const target = join(cwd, 'existing.sqlite');
  writeFileSync(target, 'do not overwrite');
  symlinkSync(target, join(directory, 'polylinedb.sqlite'));
  assert.throws(() => initializeStore({ directory, cwd }), /without links/);
  assert.equal(readFileSync(target, 'utf8'), 'do not overwrite');
});

test('a git worktree file and a dangling database link are rejected', (t) => {
  const { root, cwd } = fixture(t);
  const worktree = join(root, 'linked-worktree');
  mkdirSync(worktree, { mode: 0o700 });
  writeFileSync(join(worktree, '.git'), 'gitdir: /not-used');
  assert.throws(() => initializeStore({ directory: join(worktree, 'store'), cwd }), /outside/);
  const directory = join(root, 'data');
  mkdirSync(directory, { mode: 0o700 });
  symlinkSync(join(cwd, 'missing.sqlite'), join(directory, 'polylinedb.sqlite'));
  assert.throws(() => initializeStore({ directory, cwd }), /without links/);
  assert.equal(existsSync(join(cwd, 'missing.sqlite')), false);
});

test('a failed batch rolls back its earlier successful statement', async (t) => {
  const location = fixture(t);
  initializeStore(location);
  const store = openStore(location);
  try {
    const created = await executeOperation(store.db, parseOperation({ op: 'create', tool: 'x', project: 'y', body: 'original' }), 'alice');
    assert.ok('issue' in created);
    await assert.rejects(store.db.batch([
      { sql: 'UPDATE issues SET body = ? WHERE id = ?', params: ['partial', created.issue.id] },
      { sql: 'INSERT INTO comments(id,issue_id,body,created_at,created_by) VALUES (?,?,?,?,?)', params: ['x', 'missing', 'oops', 'now', 'alice'] },
    ]), /FOREIGN KEY/);
    const shown = await executeOperation(store.db, parseOperation({ op: 'show', id: created.issue.id }), 'reader');
    assert.ok('issue' in shown);
    assert.equal(shown.issue.body, 'original');
  } finally { store.close(); }
});

test('newer schema is rejected without rewriting its database', (t) => {
  const location = fixture(t);
  const { database_path } = initializeStore(location);
  const database = new DatabaseSync(database_path);
  database.exec('UPDATE schema_version SET version = 2');
  database.close();
  const before = readFileSync(database_path);
  for (const operation of [initializeStore, openStore]) {
    assert.throws(() => operation(location), (error: unknown) => error instanceof PolylinedbError && error.code === 'unsupported_schema');
    assert.deepEqual(readFileSync(database_path), before);
  }
});

test('existing public directories are not chmodded or populated', (t) => {
  const { root, cwd } = fixture(t);
  const directory = join(root, 'shared');
  mkdirSync(directory);
  chmodSync(directory, 0o755);
  assert.throws(() => initializeStore({ directory, cwd }), /private data directory/);
  assert.equal(statSync(directory).mode & 0o777, 0o755);
  assert.deepEqual(readdirSync(directory), []);
});
