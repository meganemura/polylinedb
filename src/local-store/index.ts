// Owns local database paths and transactions; record rules belong to records.
import { DatabaseSync } from 'node:sqlite';
import { node } from 'solarsql/node';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { commentRow, issueRow } from "../records/persistence.ts";
import { PolylinedbError } from "../records/index.ts";
import type { SqlExecutor, SqlStatement } from "../records/persistence.ts";
import { fields, SCHEMA_SQL, SCHEMA_VERSION, SCHEMA_V2_SQL, SCHEMA_V3_SQL, SCHEMA_V4_SQL, SCHEMA_V5_SQL, schemaUpgradeStatements, ROTATE_MEMORY_IDENTITY_SQL } from "../records/persistence.ts";
import { canonicalSnapshot, parseSnapshot, convertSnapshotV2, convertSnapshotV3, convertSnapshotV4 } from "../records/persistence.ts";
import { claimRow, claimRequestRow } from '../records/persistence.ts';
import type { Snapshot, SnapshotImport } from "../records/persistence.ts";
import { issueSortKey } from "../records/persistence.ts";
import { memoryRow, memorySortKey } from "../records/persistence.ts";

export type LocalStore = { db: SqlExecutor; exportSnapshot(): Snapshot; importSnapshot(snapshot: Snapshot): SnapshotImport; close(): void };

type StoreLocation = { directory: string; cwd?: string };
const fail = (message: string, details?: unknown): never => { throw new PolylinedbError('invalid_data_directory', message, 400, details); };

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
  const repositoryBoundaryMessage = 'The data directory must be outside the working directory and Git repositories';
  if (inside(destination, workDirectory)) return fail(repositoryBoundaryMessage, { rule: 'working_directory' });
  if ((workRepository && inside(destination, workRepository)) || repository(destination)) return fail(repositoryBoundaryMessage, { rule: 'git_repository' });
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
  if (['issues', 'comments', 'counters', 'requests', 'memories', 'memory_counters', 'memory_requests', 'memory_store_identity', 'project_memory_revisions', 'dependencies', 'dependency_revisions', 'dependency_requests', 'issue_claims', 'claim_requests'].some(name => !tables.some(table => table.name === name))) {
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
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    return database;
  } catch (error) { database.close(); throw error; }
}

const retiredTables = ['issues', 'comments', 'counters', 'requests', 'memories', 'memory_counters', 'memory_requests',
  'memory_store_identity', 'project_memory_revisions', 'dependencies', 'dependency_revisions', 'dependency_requests', 'issue_claims', 'claim_requests'] as const;
const retiredOperations = ['INSERT', 'UPDATE', 'DELETE'] as const;
function retiredConnection(database: DatabaseSync, error: unknown): string | undefined {
  if (!database.isTransaction || !(error instanceof Error) || !('code' in error) || error.code !== 'ERR_SQLITE_ERROR' ||
    !('errcode' in error) || error.errcode !== 1811) return undefined;
  const match = /^This local database is retired\. Use cloud connection ([a-z][a-z0-9_-]{0,63})\.$/.exec(error.message);
  const connectionName = match?.[1];
  if (!connectionName) return undefined;
  let rows: Record<string, unknown>[];
  try {
    rows = database.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'polylinedb_retired_*'").all();
  } catch { return undefined; }
  const version = database.prepare('SELECT version FROM schema_version').get()?.version;
  const tables = version === 2 ? retiredTables.slice(0, 4) : version === 3 ? retiredTables.slice(0, 7) : version === 4 ? retiredTables.slice(0, 9) : version === 5 ? retiredTables.slice(0, 12) : retiredTables;
  if (rows.length !== tables.length * retiredOperations.length) return undefined;
  const actual = new Map<string, { table: string; sql: string }>();
  for (const row of rows) {
    if (typeof row.name !== 'string' || typeof row.tbl_name !== 'string' || typeof row.sql !== 'string') return undefined;
    actual.set(row.name, { table: row.tbl_name, sql: row.sql });
  }
  const message = `This local database is retired. Use cloud connection ${connectionName}.`;
  for (const table of tables) for (const operation of retiredOperations) {
    const name = `polylinedb_retired_${table}_${operation.toLowerCase()}`;
    const sql = `CREATE TRIGGER "${name}" BEFORE ${operation} ON "${table}" BEGIN SELECT RAISE(ABORT, '${message}'); END`;
    const trigger = actual.get(name);
    if (!trigger || trigger.table !== table || trigger.sql !== sql) return undefined;
  }
  return connectionName;
}
function historicalRetirement(database: DatabaseSync): string | undefined {
  const rows = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'polylinedb_retired_*'").all();
  const sql = rows[0]?.sql;
  if (typeof sql !== 'string') return undefined;
  const match = /This local database is retired\. Use cloud connection ([a-z][a-z0-9_-]{0,63})\./.exec(sql);
  if (!match?.[1]) return undefined;
  const error = Object.assign(new Error(`This local database is retired. Use cloud connection ${match[1]}.`), { code: 'ERR_SQLITE_ERROR', errcode: 1811 });
  return retiredConnection(database, error);
}
function rollbackWrite(database: DatabaseSync, error: unknown): never {
  const connectionName = retiredConnection(database, error);
  try { database.exec('ROLLBACK'); } catch { throw error; }
  if (connectionName !== undefined) throw new PolylinedbError('store_retired', `This local database is retired. Use cloud connection ${connectionName}.`, 409);
  throw error;
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

export function upgradeStore(location: StoreLocation): { result: 'upgraded' | 'already_current'; version: number; database_path: string } {
  const { database_path } = approvedPath(location);
  if (!existsSync(database_path)) throw new PolylinedbError('uninitialized_store', 'Initialize this store first', 400);
  const database = connect(database_path);
  const reference = new DatabaseSync(':memory:');
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      const versions = database.prepare('SELECT version FROM schema_version').all();
      const retired = historicalRetirement(database);
      if (retired !== undefined) throw new PolylinedbError('store_retired', `This local database is retired. Use cloud connection ${retired}.`, 409);
      if (versions.length === 1 && versions[0]?.version === SCHEMA_VERSION) {
        schemaVersion(database);
        database.exec('COMMIT');
        return { result: 'already_current', version: SCHEMA_VERSION, database_path };
      }
      if (versions.length !== 1 || (versions[0]?.version !== 2 && versions[0]?.version !== 3 && versions[0]?.version !== 4 && versions[0]?.version !== 5)) throw new PolylinedbError('unsupported_schema', 'Only schemas 2, 3, 4 and 5 can be upgraded', 409);
      const previous = versions[0].version;
      reference.exec(previous === 2 ? SCHEMA_V2_SQL : previous === 3 ? SCHEMA_V3_SQL : previous === 4 ? SCHEMA_V4_SQL : SCHEMA_V5_SQL);
      const sql = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
      if (JSON.stringify(database.prepare(sql).all()) !== JSON.stringify(reference.prepare(sql).all())) throw new PolylinedbError('invalid_store', `Upgrade requires the canonical schema ${previous}`, 409);
      database.exec(schemaUpgradeStatements(previous).join(';\n') + ';');
      database.exec('COMMIT');
      return { result: 'upgraded', version: SCHEMA_VERSION, database_path };
    } catch (error) { database.exec('ROLLBACK'); throw error; }
  } finally { reference.close(); database.close(); }
}

export function openStore(location: StoreLocation): LocalStore {
  const { database_path } = approvedPath(location);
  if (!existsSync(database_path)) throw new PolylinedbError('uninitialized_store', 'Run init for this data directory first', 400);
  verifyExisting(database_path, false);
  const database = connect(database_path);
  const db: SqlExecutor = {
    reads: node(database),
    async batch(statements: readonly SqlStatement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(({ sql, params }) => ({ rows: database.prepare(sql).all(...params) }));
        database.exec('COMMIT');
        return results;
      } catch (error) { rollbackWrite(database, error); }
    },
  };
  const readSnapshot = (): Snapshot => parseSnapshot({
    format: 'polylinedb.snapshot', version: 5,
    issues: database.prepare('SELECT * FROM issues').all().map(row => {
      const issue = issueRow(row);
      const split = issue.id.lastIndexOf('.');
      if (row.parent_id !== (split < 0 ? null : issue.id.slice(0, split))) throw new PolylinedbError('invalid_store', 'Stored parent does not match the issue ID', 500);
      if (row.sort_key !== issueSortKey(issue.id)) throw new PolylinedbError('invalid_store', 'Stored ordering does not match the issue ID', 500);
      return issue;
    }),
    comments: database.prepare('SELECT * FROM comments').all().map(commentRow),
    counters: database.prepare('SELECT scope, last_number FROM counters').all(),
    requests: database.prepare('SELECT request_id, actor, payload, issue_id FROM requests').all(),
    memories: database.prepare('SELECT * FROM memories').all().map(row => {
      const memory = memoryRow(row);
      if (row.sort_key !== memorySortKey(memory.id)) throw new PolylinedbError('invalid_store', 'Stored memory ordering differs from its ID', 500);
      return memory;
    }),
    memory_counters: database.prepare('SELECT prefix, last_number FROM memory_counters').all(),
    memory_requests: database.prepare('SELECT request_id, actor, payload, memory_id FROM memory_requests').all(),
    dependencies: database.prepare('SELECT dependent_id,blocker_id FROM dependencies').all(),
    dependency_revisions: database.prepare('SELECT dependent_id,revision FROM dependency_revisions').all(),
    dependency_requests: database.prepare('SELECT * FROM dependency_requests').all(),
    issue_claims: database.prepare('SELECT * FROM issue_claims').all().map(claimRow),
    claim_requests: database.prepare('SELECT * FROM claim_requests').all().map(claimRequestRow),
  });
  return {
    db,
    exportSnapshot() {
      database.exec('BEGIN');
      try { const snapshot = readSnapshot(); database.exec('COMMIT'); return snapshot; }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
    importSnapshot(input) {
      const snapshot = parseSnapshot(input);
      const canonical = canonicalSnapshot(snapshot);
      const summary = { issues: snapshot.issues.length, comments: snapshot.comments.length, memories: snapshot.memories.length, dependencies: snapshot.dependencies.length, dependency_revisions: snapshot.dependency_revisions.length, dependency_requests: snapshot.dependency_requests.length, issue_claims: snapshot.issue_claims.length, claim_requests: snapshot.claim_requests.length, sha256: createHash('sha256').update(canonical).digest('hex') };
      database.exec('BEGIN IMMEDIATE');
      try {
        const existing = readSnapshot();
        if (canonicalSnapshot(existing) === canonical) {
          database.exec('COMMIT');
          return { result: 'already_present', ...summary };
        }
        if (existing.issues.length || existing.comments.length || existing.counters.length || existing.requests.length || existing.memories.length || existing.memory_counters.length || existing.memory_requests.length || existing.dependencies.length || existing.dependency_revisions.length || existing.dependency_requests.length || existing.issue_claims.length || existing.claim_requests.length) throw new PolylinedbError('destination_not_empty', 'Snapshot import requires an empty store or identical contents', 409);
        database.exec(ROTATE_MEMORY_IDENTITY_SQL);
        const columns = ['id', 'parent_id', 'sort_key', ...fields.map(field => field === 'labels' ? 'labels_json' : field), ...fields.map(field => `${field}_v`), 'created_at', 'created_by', 'updated_at', 'updated_by'];
        const insertIssue = database.prepare(`INSERT INTO issues (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
        const issues = [...snapshot.issues].sort((a, b) => a.id.split('.').length - b.id.split('.').length);
        for (const issue of issues) {
          const split = issue.id.lastIndexOf('.');
          insertIssue.run(issue.id, split < 0 ? null : issue.id.slice(0, split), issueSortKey(issue.id), ...fields.map(field => field === 'labels' ? JSON.stringify(issue.labels) : issue[field]), ...fields.map(field => issue.versions[field]), issue.created_at, issue.created_by, issue.updated_at, issue.updated_by);
        }
        const insertComment = database.prepare('INSERT INTO comments (id, issue_id, body, created_at, created_by) VALUES (?, ?, ?, ?, ?)');
        for (const comment of snapshot.comments) insertComment.run(comment.id, comment.issue_id, comment.body, comment.created_at, comment.created_by);
        const insertCounter = database.prepare('INSERT INTO counters(scope, last_number) VALUES (?, ?)');
        for (const counter of snapshot.counters) insertCounter.run(counter.scope, counter.last_number);
        const insertRequest = database.prepare('INSERT INTO requests(request_id, actor, payload, issue_id) VALUES (?, ?, ?, ?)');
        for (const request of snapshot.requests) insertRequest.run(request.request_id, request.actor, request.payload, request.issue_id);
        const insertMemory = database.prepare('INSERT INTO memories(id,sort_key,project,title,body,version,created_at,created_by,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?)');
        for (const memory of snapshot.memories) insertMemory.run(memory.id, memorySortKey(memory.id), memory.project, memory.title, memory.body, memory.version, memory.created_at, memory.created_by, memory.updated_at, memory.updated_by);
        const insertMemoryCounter = database.prepare('INSERT INTO memory_counters(prefix,last_number) VALUES (?,?)');
        for (const counter of snapshot.memory_counters) insertMemoryCounter.run(counter.prefix, counter.last_number);
        const insertMemoryRequest = database.prepare('INSERT INTO memory_requests(request_id,actor,payload,memory_id) VALUES (?,?,?,?)');
        for (const request of snapshot.memory_requests) insertMemoryRequest.run(request.request_id, request.actor, request.payload, request.memory_id);
        const insertDependency = database.prepare('INSERT INTO dependencies(dependent_id,blocker_id) VALUES (?,?)');
        for (const edge of snapshot.dependencies) insertDependency.run(edge.dependent_id, edge.blocker_id);
        const updateRevision = database.prepare('UPDATE dependency_revisions SET revision = ? WHERE dependent_id = ?');
        for (const row of snapshot.dependency_revisions) updateRevision.run(row.revision, row.dependent_id);
        const insertDependencyRequest = database.prepare('INSERT INTO dependency_requests(request_id,actor,payload,dependent_id,blocker_id,result_revision,outcome,created_at) VALUES (?,?,?,?,?,?,?,?)');
        for (const row of snapshot.dependency_requests) insertDependencyRequest.run(row.request_id, row.actor, row.payload, row.dependent_id, row.blocker_id, row.result_revision, row.outcome, row.created_at);
        for (const table of ['issue_claims', 'claim_requests'] as const) for (const row of snapshot[table]) {
          const columns = Object.keys(row); const values = Object.values(row);
          database.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...values);
        }
        if (canonicalSnapshot(readSnapshot()) !== canonical) throw new PolylinedbError('invalid_store', 'Restored snapshot does not match the input', 500);
        database.exec('COMMIT');
        return { result: 'imported', ...summary };
      } catch (error) { rollbackWrite(database, error); }
    },
    close: () => database.close(),
  };
}

export function exportHistoricalSnapshot(location: StoreLocation): Snapshot {
  const { database_path } = approvedPath(location);
  if (!existsSync(database_path)) throw new PolylinedbError('uninitialized_store', 'Initialize this store first', 400);
  const database = new DatabaseSync(database_path, { readOnly: true });
  const reference = new DatabaseSync(':memory:');
  try {
    database.exec('BEGIN');
    const rows = database.prepare('SELECT version FROM schema_version').all();
    const version = rows[0]?.version;
    if (rows.length !== 1 || (version !== 2 && version !== 3 && version !== 4 && version !== 5)) throw new PolylinedbError('unsupported_schema', 'Historical export requires schema 2, 3, 4 or 5', 409);
    reference.exec(version === 2 ? SCHEMA_V2_SQL : version === 3 ? SCHEMA_V3_SQL : version === 4 ? SCHEMA_V4_SQL : SCHEMA_V5_SQL);
    const guards = database.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'polylinedb_retired_*'").all();
    if (guards.length && historicalRetirement(database) === undefined) throw new PolylinedbError('invalid_store', 'Historical retirement guards differ from the canonical guards', 409);
    const sql = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT GLOB 'polylinedb_retired_*' ORDER BY name";
    if (JSON.stringify(database.prepare(sql).all()) !== JSON.stringify(reference.prepare(sql).all())) throw new PolylinedbError('invalid_store', 'Historical export requires a canonical schema', 409);
    const snapshot = { format: 'polylinedb.snapshot', version: 2,
      issues: database.prepare('SELECT * FROM issues').all().map(row => {
        const issue = issueRow(row); const split = issue.id.lastIndexOf('.');
        if (row.sort_key !== issueSortKey(issue.id) || row.parent_id !== (split < 0 ? null : issue.id.slice(0, split))) throw new PolylinedbError('invalid_store', 'Historical issue identity differs', 500);
        return issue;
      }), comments: database.prepare('SELECT * FROM comments').all().map(commentRow), counters: database.prepare('SELECT * FROM counters').all(), requests: database.prepare('SELECT * FROM requests').all() };
    const converted = version === 2 ? convertSnapshotV2(snapshot) : convertSnapshotV3({ ...snapshot, version: 3,
      memories: database.prepare('SELECT * FROM memories').all().map(row => {
        const memory = memoryRow(row);
        if (row.sort_key !== memorySortKey(memory.id)) throw new PolylinedbError('invalid_store', 'Historical memory ordering differs', 500);
        return memory;
      }), memory_counters: database.prepare('SELECT * FROM memory_counters').all(), memory_requests: database.prepare('SELECT * FROM memory_requests').all() });
    const { issue_claims: _, claim_requests: __, ...legacyConverted } = converted;
    const complete = version === 5 ? convertSnapshotV4({ ...legacyConverted, version: 4,
      dependencies: database.prepare('SELECT * FROM dependencies').all(), dependency_revisions: database.prepare('SELECT * FROM dependency_revisions').all(), dependency_requests: database.prepare('SELECT * FROM dependency_requests').all() }) : converted;
    database.exec('COMMIT'); return complete;
  } finally { reference.close(); database.close(); }
}
