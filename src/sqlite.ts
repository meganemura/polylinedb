// Owns local database paths and transactions; issue policy remains in issues.ts.
import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { PolylinedbError } from './issues.ts';
import type { SqlExecutor, SqlStatement } from './issues.ts';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts';

type StoreLocation = { directory: string; cwd?: string };
const fail = (message: string): never => { throw new PolylinedbError('invalid_data_directory', message, 400); };

function canonical(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  // lstat also detects dangling symlinks, which must not become a path bypass.
  try { if (lstatSync(path).isSymbolicLink()) fail('The data path contains a dangling symlink'); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const parent = dirname(path);
  if (parent === path) return path;
  return join(canonical(parent), relative(parent, path));
}
function inside(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}
function repository(path: string): string | undefined {
  for (let current = path; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return current;
    if (dirname(current) === current) return undefined;
  }
}
function approvedPath({ directory, cwd = process.cwd() }: StoreLocation): { directory: string; database_path: string } {
  if (typeof directory !== 'string' || !isAbsolute(directory)) return fail('An absolute data directory is required');
  const workDirectory = canonical(resolve(cwd));
  const destination = canonical(directory);
  const workRepository = repository(workDirectory);
  if (inside(destination, workDirectory) || (workRepository && inside(destination, workRepository)) || repository(destination)) {
    return fail('The data directory must be outside the working directory and Git repositories');
  }
  if (existsSync(destination) && !statSync(destination).isDirectory()) return fail('The data directory is not a directory');
  if (existsSync(destination) && (statSync(destination).mode & 0o077) !== 0) return fail('Use a private data directory with mode 0700');
  const database_path = join(destination, 'polylinedb.sqlite');
  try {
    const stat = lstatSync(database_path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) return fail('The database must be a regular file without links');
    if ((stat.mode & 0o077) !== 0) return fail('The database must have mode 0600');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return { directory: destination, database_path };
}
function schemaVersion(database: DatabaseSync): 'empty' | 'current' {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  if (tables.length === 0) return 'empty';
  if (!tables.some((table) => table.name === 'schema_version')) throw new PolylinedbError('invalid_store', 'Database has no polylinedb schema version', 500);
  const rows = database.prepare('SELECT version FROM schema_version').all();
  if (rows.length !== 1 || rows[0]?.version !== SCHEMA_VERSION) {
    throw new PolylinedbError('unsupported_schema', 'Database schema version is unsupported', 409, { supported: SCHEMA_VERSION, actual: rows.map((row) => row.version) });
  }
  if (!tables.some((table) => table.name === 'issues') || !tables.some((table) => table.name === 'comments')) {
    throw new PolylinedbError('invalid_store', 'Database schema is incomplete', 500);
  }
  return 'current';
}
function verifyExisting(path: string, allowEmpty: boolean): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    if (schemaVersion(database) === 'empty' && !allowEmpty) throw new PolylinedbError('uninitialized_store', 'Run init for this data directory first', 400);
  } finally { database.close(); }
}
function connect(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE;');
    return database;
  } catch (error) { database.close(); throw error; }
}

export function initializeStore(location: StoreLocation): { database_path: string } {
  const approved = approvedPath(location);
  if (existsSync(approved.database_path)) verifyExisting(approved.database_path, true);
  mkdirSync(approved.directory, { recursive: true, mode: 0o700 });
  try { closeSync(openSync(approved.database_path, 'wx', 0o600)); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
  approvedPath(location);
  const database = connect(approved.database_path);
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      if (schemaVersion(database) === 'empty') database.exec(SCHEMA_SQL);
      database.exec('COMMIT');
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  } finally { database.close(); }
  return { database_path: approved.database_path };
}

export function openStore(location: StoreLocation): { db: SqlExecutor; close(): void } {
  const { database_path } = approvedPath(location);
  if (!existsSync(database_path)) throw new PolylinedbError('uninitialized_store', 'Run init for this data directory first', 400);
  verifyExisting(database_path, false);
  const database = connect(database_path);
  const db: SqlExecutor = {
    async batch(statements: readonly SqlStatement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(({ sql, params }) => ({ rows: database.prepare(sql).all(...params) }));
        database.exec('COMMIT');
        return results;
      } catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
  return { db, close: () => database.close() };
}
