// Owns additive D1 merge planning and local source retirement. Remote selection and execution stay outside.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { commentRow, issueRow } from '../src/records/persistence.ts';
import { issueSortKey } from '../src/records/persistence.ts';
import { fields, SCHEMA_SQL, SCHEMA_VERSION } from '../src/records/persistence.ts';
import { memoryRow, memorySortKey } from '../src/records/persistence.ts';
import { canonicalSnapshot, parseSnapshot } from '../src/records/persistence.ts';
import type { Snapshot } from '../src/records/persistence.ts';

export const tables = ['issues', 'comments', 'counters', 'requests', 'memories', 'memory_counters', 'memory_requests', 'dependencies', 'dependency_revisions', 'dependency_requests', 'issue_claims', 'claim_requests', 'memory_store_identity', 'project_memory_revisions'] as const;
export type Table = typeof tables[number];
export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;
export type Rows = Readonly<Record<Table, readonly Row[]>>;
export type Statement = { sql: string; params: SqlValue[] };
export type Counts = { added: Record<Table, number>; total: Record<Table, number> };
export type MergePlan = { statements: Statement[]; expectedSnapshot: Snapshot; digest: string; counts: Counts };

const primaryKey: Record<Table, string> = {
  issues: 'id', comments: 'id', counters: 'scope', requests: 'request_id', memories: 'id',
  memory_counters: 'prefix', memory_requests: 'request_id',
  dependencies: 'dependent_id', dependency_revisions: 'dependent_id', dependency_requests: 'request_id',
  issue_claims: 'issue_id', claim_requests: 'request_id', memory_store_identity: 'singleton', project_memory_revisions: 'project',
};
const maximumJsonBytes = 400_000;
const maximumSqlBytes = 100_000;
const maximumParameters = 100;

function fail(message: string): never { throw new Error(message); }

function columnsFor(database: DatabaseSync, table: Table): string[] {
  const columns = database.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name);
  if (columns.length === 0 || columns.some(column => typeof column !== 'string')) fail(`Canonical schema has no columns for ${table}`);
  return columns.map(column => {
    if (typeof column !== 'string' || !/^[a-z][a-z0-9_]*$/.test(column)) fail(`Invalid canonical column for ${table}`);
    return column;
  });
}

function canonicalColumns(): Record<Table, string[]> {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(SCHEMA_SQL);
    return {
      issues: columnsFor(database, 'issues'),
      comments: columnsFor(database, 'comments'),
      counters: columnsFor(database, 'counters'),
      requests: columnsFor(database, 'requests'),
      memories: columnsFor(database, 'memories'),
      memory_counters: columnsFor(database, 'memory_counters'),
      memory_requests: columnsFor(database, 'memory_requests'),
      dependencies: columnsFor(database, 'dependencies'), dependency_revisions: columnsFor(database, 'dependency_revisions'), dependency_requests: columnsFor(database, 'dependency_requests'),
      issue_claims: columnsFor(database, 'issue_claims'), claim_requests: columnsFor(database, 'claim_requests'), memory_store_identity: columnsFor(database, 'memory_store_identity'), project_memory_revisions: columnsFor(database, 'project_memory_revisions'),
    };
  } finally { database.close(); }
}

const columns = canonicalColumns();

function plainRecord(value: unknown, description: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${description} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${description} must be a plain object`);
  const record: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) record[key] = field;
  return record;
}

function sqlValue(value: unknown, description: string): SqlValue {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  return fail(`${description} must contain only text, safe integers, or null`);
}

function parseRow(value: unknown, table: Table): Row {
  const input = plainRecord(value, `${table} row`);
  const actualColumns = Object.keys(input).sort();
  const expectedColumns = [...columns[table]].sort();
  if (actualColumns.join('\0') !== expectedColumns.join('\0')) fail(`${table} row columns differ from the canonical schema`);
  const row: Row = {};
  for (const column of columns[table]) row[column] = sqlValue(input[column], `${table}.${column}`);
  return row;
}

function parseCollection(value: unknown, table: Table): Row[] {
  if (!Array.isArray(value)) fail(`${table} must be an array`);
  return value.map(row => parseRow(row, table));
}

function parseRows(value: unknown): Rows {
  const input = plainRecord(value, 'Raw rows');
  if (Object.keys(input).sort().join('\0') !== [...tables].sort().join('\0')) fail('Raw rows must contain all canonical collections');
  return {
    issues: parseCollection(input.issues, 'issues'),
    comments: parseCollection(input.comments, 'comments'),
    counters: parseCollection(input.counters, 'counters'),
    requests: parseCollection(input.requests, 'requests'),
    memories: parseCollection(input.memories, 'memories'),
    memory_counters: parseCollection(input.memory_counters, 'memory_counters'),
    memory_requests: parseCollection(input.memory_requests, 'memory_requests'),
    dependencies: parseCollection(input.dependencies, 'dependencies'), dependency_revisions: parseCollection(input.dependency_revisions, 'dependency_revisions'), dependency_requests: parseCollection(input.dependency_requests, 'dependency_requests'),
    issue_claims: parseCollection(input.issue_claims, 'issue_claims'), claim_requests: parseCollection(input.claim_requests, 'claim_requests'), memory_store_identity: parseCollection(input.memory_store_identity, 'memory_store_identity'), project_memory_revisions: parseCollection(input.project_memory_revisions, 'project_memory_revisions'),
  };
}

function valueForIssueField(issue: Snapshot['issues'][number], field: typeof fields[number]): SqlValue {
  switch (field) {
    case 'tool': return issue.tool;
    case 'project': return issue.project;
    case 'body': return issue.body;
    case 'status': return issue.status;
    case 'type': return issue.type;
    case 'priority': return issue.priority;
    case 'labels': return JSON.stringify(issue.labels);
    default: { const unreachable: never = field; return unreachable; }
  }
}

function issueRowFromSnapshot(issue: Snapshot['issues'][number]): Row {
  const parentSeparator = issue.id.lastIndexOf('.');
  const row: Row = {
    id: issue.id,
    parent_id: parentSeparator < 0 ? null : issue.id.slice(0, parentSeparator),
    sort_key: issueSortKey(issue.id),
  };
  for (const field of fields) {
    row[field === 'labels' ? 'labels_json' : field] = valueForIssueField(issue, field);
    row[`${field}_v`] = issue.versions[field];
  }
  row.created_at = issue.created_at;
  row.created_by = issue.created_by;
  row.updated_at = issue.updated_at;
  row.updated_by = issue.updated_by;
  row.closed_at = issue.closed_at;
  row.closed_by = issue.closed_by;
  return row;
}

function rowsFromSnapshot(snapshot: Snapshot, metadata: Pick<Rows, 'memory_store_identity' | 'project_memory_revisions'>): Rows {
  return {
    issues: snapshot.issues.map(issueRowFromSnapshot),
    comments: snapshot.comments.map(row => ({ ...row })),
    counters: snapshot.counters.map(row => ({ ...row })),
    requests: snapshot.requests.map(row => ({ ...row })),
    memories: snapshot.memories.map(memory => ({ ...memory, sort_key: memorySortKey(memory.id) })),
    memory_counters: snapshot.memory_counters.map(row => ({ ...row })),
    memory_requests: snapshot.memory_requests.map(row => ({ ...row })),
    dependencies: snapshot.dependencies.map(row => ({ ...row })), dependency_revisions: snapshot.dependency_revisions.map(row => ({ ...row })), dependency_requests: snapshot.dependency_requests.map(row => ({ ...row })),
    issue_claims: snapshot.issue_claims.map(row => ({ ...row })), claim_requests: snapshot.claim_requests.map(row => ({ ...row })), ...metadata,
  };
}

function rowKey(row: Row, table: Table): string {
  if (table === 'memory_store_identity') { if (row.singleton !== 1) return fail('Invalid store identity singleton'); return '1'; }
  if (table === 'dependencies') return JSON.stringify([textField(row, 'dependent_id'), textField(row, 'blocker_id')]);
  const value = row[primaryKey[table]];
  if (typeof value !== 'string') fail(`${table} primary key must be text`);
  return value;
}

function textField(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') fail(`Receipt field ${field} must be text`);
  return value;
}

function rowSignature(row: Row, table: Table): string {
  return JSON.stringify(columns[table].map(column => row[column]));
}

function assertCanonicalRows(actual: Rows, expected: Rows): void {
  for (const table of tables) {
    const expectedRows = new Map(expected[table].map(row => [rowKey(row, table), rowSignature(row, table)]));
    if (actual[table].length !== expectedRows.size) fail(`${table} rows are not a canonical snapshot`);
    for (const row of actual[table]) {
      if (expectedRows.get(rowKey(row, table)) !== rowSignature(row, table)) fail(`${table} rows are not a canonical snapshot`);
    }
  }
}

function snapshotFromRows(rows: Rows): Snapshot {
  if (rows.memory_store_identity.length !== 1 || rows.memory_store_identity[0]?.singleton !== 1 || typeof rows.memory_store_identity[0]?.incarnation !== 'string' || !/^[a-f0-9]{32}$/.test(rows.memory_store_identity[0].incarnation)) fail('Invalid captured store incarnation');
  const projects = new Set<string>();
  for (const row of rows.project_memory_revisions) {
    if (typeof row.project !== 'string' || !row.project || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 0 || projects.has(row.project)) fail('Invalid captured project memory revision');
    projects.add(row.project);
  }
  for (const row of rows.memories) if (!projects.has(textField(row, 'project'))) fail('Memory project has no captured revision');
  const snapshot = parseSnapshot({
    format: 'polylinedb.snapshot',
    version: 6,
    issues: rows.issues.map(issueRow),
    comments: rows.comments.map(commentRow),
    counters: rows.counters,
    requests: rows.requests,
    memories: rows.memories.map(memoryRow),
    memory_counters: rows.memory_counters,
    memory_requests: rows.memory_requests,
    dependencies: rows.dependencies, dependency_revisions: rows.dependency_revisions, dependency_requests: rows.dependency_requests,
    issue_claims: rows.issue_claims, claim_requests: rows.claim_requests,
  });
  assertCanonicalRows(rows, rowsFromSnapshot(snapshot, { memory_store_identity: rows.memory_store_identity, project_memory_revisions: rows.project_memory_revisions }));
  return snapshot;
}

export function rawToSnapshot(value: unknown): Snapshot {
  return snapshotFromRows(parseRows(value));
}

function disjointValues(left: readonly string[], right: readonly string[], message: string): void {
  const rightValues = new Set(right);
  if (left.some(value => rightValues.has(value))) fail(message);
}

function assertDisjoint(source: Rows, destination: Rows): void {
  disjointValues(source.memories.map(row => rowKey(row, 'memories')), destination.memory_requests.map(row => textField(row, 'memory_id')), 'A destination deletion receipt would be undone by a source memory');
  disjointValues(destination.memories.map(row => rowKey(row, 'memories')), source.memory_requests.map(row => textField(row, 'memory_id')), 'A source deletion receipt would be undone by a destination memory');
  disjointValues(source.requests.map(row => textField(row, 'issue_id')), destination.requests.map(row => textField(row, 'issue_id')), 'Source and destination receipts share an issue ID');
  disjointValues(source.memory_requests.map(row => textField(row, 'memory_id')), destination.memory_requests.map(row => textField(row, 'memory_id')), 'Source and destination receipts share a memory ID');
  for (const table of ['counters', 'memory_counters'] as const) {
    disjointValues(source[table].map(row => rowKey(row, table)), destination[table].map(row => rowKey(row, table)), 'Source and destination share a counter namespace');
  }
  for (const table of tables) {
    if (table === 'memory_store_identity' || table === 'project_memory_revisions') continue;
    disjointValues(source[table].map(row => rowKey(row, table)), destination[table].map(row => rowKey(row, table)), `Source and destination share a ${table} key`);
  }
}

function compareBinaryText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function orderedRows(rows: readonly Row[], table: Table): Row[] {
  if (table === 'dependencies') return [...rows].sort((left, right) => compareBinaryText(issueSortKey(textField(left, 'dependent_id')), issueSortKey(textField(right, 'dependent_id'))) || compareBinaryText(issueSortKey(textField(left, 'blocker_id')), issueSortKey(textField(right, 'blocker_id'))));
  return [...rows].sort((left, right) => compareBinaryText(rowKey(left, table), rowKey(right, table)));
}

function issueInsertOrder(rows: readonly Row[]): Row[] {
  return [...rows].sort((left, right) => {
    const leftId = rowKey(left, 'issues');
    const rightId = rowKey(right, 'issues');
    return leftId.split('.').length - rightId.split('.').length || compareBinaryText(leftId, rightId);
  });
}

function serializedChunks(rows: readonly Row[]): { rows: Row[]; json: string }[] {
  const chunks: { rows: Row[]; json: string }[] = [];
  let current: Row[] = [];
  for (const row of rows) {
    const candidate = [...current, row];
    const json = JSON.stringify(candidate);
    if (Buffer.byteLength(json, 'utf8') <= maximumJsonBytes) {
      current = candidate;
      continue;
    }
    if (current.length === 0) fail('One raw row exceeds the D1 JSON transfer limit');
    chunks.push({ rows: current, json: JSON.stringify(current) });
    current = [row];
    if (Buffer.byteLength(JSON.stringify(current), 'utf8') > maximumJsonBytes) fail('One raw row exceeds the D1 JSON transfer limit');
  }
  if (current.length > 0) chunks.push({ rows: current, json: JSON.stringify(current) });
  return chunks;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) fail('Invalid canonical SQL identifier');
  return `"${value}"`;
}

function checkedStatement(statement: Statement): Statement {
  if (Buffer.byteLength(statement.sql, 'utf8') >= maximumSqlBytes || statement.params.length > maximumParameters) fail('D1 statement limit exceeded');
  return statement;
}

function schemaGuard(): Statement {
  return checkedStatement({
    sql: `INSERT INTO schema_version(version) SELECT 0 WHERE (SELECT COUNT(*) FROM schema_version) <> 1 OR NOT EXISTS (SELECT 1 FROM schema_version WHERE version = ${SCHEMA_VERSION})`,
    params: [],
  });
}

function destinationGuard(table: Table, chunk: { rows: Row[]; json: string }, lower: string | undefined, upper: string | undefined): Statement {
  const fieldList = columns[table].map(quoteIdentifier).join(', ');
  const jsonFields = columns[table].map(column => `json_extract(entry.value, '$.${column}') AS ${quoteIdentifier(column)}`).join(', ');
  const key = table === 'dependencies' ? '((SELECT sort_key FROM issues WHERE id = dependent_id),(SELECT sort_key FROM issues WHERE id = blocker_id))' : quoteIdentifier(primaryKey[table]);
  const placeholder = table === 'dependencies' ? '(?,?)' : '?';
  const conditions = [lower === undefined ? '' : ` AND ${key} > ${placeholder}`, upper === undefined ? '' : ` AND ${key} <= ${placeholder}`].join('');
  const predicates = [lower, upper].filter((value): value is string => value !== undefined).flatMap(value => {
    if (table !== 'dependencies') return [value];
    const tuple: unknown = JSON.parse(value);
    if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== 'string' || typeof tuple[1] !== 'string') return fail('Invalid captured dependency tuple');
    return [issueSortKey(tuple[0]), issueSortKey(tuple[1])];
  });
  return checkedStatement({
    sql: `WITH captured AS (SELECT ${jsonFields} FROM json_each(?) AS entry), current_rows AS (SELECT ${fieldList} FROM ${quoteIdentifier(table)} WHERE 1${conditions}) INSERT INTO schema_version(version) SELECT 0 WHERE EXISTS (SELECT ${fieldList} FROM current_rows EXCEPT SELECT ${fieldList} FROM captured) OR EXISTS (SELECT ${fieldList} FROM captured EXCEPT SELECT ${fieldList} FROM current_rows)`,
    params: [chunk.json, ...predicates],
  });
}

function destinationGuards(rows: Rows): Statement[] {
  const statements: Statement[] = [];
  for (const table of tables) {
    const chunks = serializedChunks(orderedRows(rows[table], table));
    if (chunks.length === 0) {
      statements.push(destinationGuard(table, { rows: [], json: '[]' }, undefined, undefined));
      continue;
    }
    let lower: string | undefined;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk) fail('Missing destination guard chunk');
      const lastRow = chunk.rows.at(-1);
      if (!lastRow) fail('Destination guard chunk must contain a row');
      const upper = index === chunks.length - 1 ? undefined : rowKey(lastRow, table);
      statements.push(destinationGuard(table, chunk, lower, upper));
      lower = rowKey(lastRow, table);
    }
  }
  return statements;
}

function sourceInsert(table: Table, chunk: { rows: Row[]; json: string }): Statement {
  const fieldList = columns[table].map(quoteIdentifier).join(', ');
  const jsonFields = columns[table].map(column => `json_extract(entry.value, '$.${column}')`).join(', ');
  return checkedStatement({
    sql: `INSERT INTO ${quoteIdentifier(table)}(${fieldList}) SELECT ${jsonFields} FROM json_each(?) AS entry${table === 'dependency_revisions' ? ' WHERE 1 ON CONFLICT(dependent_id) DO UPDATE SET revision = excluded.revision WHERE dependency_revisions.revision = 1' : ''}`,
    params: [chunk.json],
  });
}

function sourceInserts(rows: Rows): Statement[] {
  const statements: Statement[] = [];
  for (const table of tables) {
    if (table === 'memory_store_identity' || table === 'project_memory_revisions') continue;
    const ordered = table === 'issues' ? issueInsertOrder(rows.issues) : orderedRows(rows[table], table);
    for (const chunk of serializedChunks(ordered)) statements.push(sourceInsert(table, chunk));
  }
  return statements;
}

function counts(rows: Rows): Record<Table, number> {
  return {
    issues: rows.issues.length,
    comments: rows.comments.length,
    counters: rows.counters.length,
    requests: rows.requests.length,
    memories: rows.memories.length,
    memory_counters: rows.memory_counters.length,
    memory_requests: rows.memory_requests.length,
    dependencies: rows.dependencies.length, dependency_revisions: rows.dependency_revisions.length, dependency_requests: rows.dependency_requests.length,
    issue_claims: rows.issue_claims.length, claim_requests: rows.claim_requests.length, memory_store_identity: rows.memory_store_identity.length, project_memory_revisions: rows.project_memory_revisions.length,
  };
}

export function additiveMerge(input: { source: unknown; destination: unknown }): MergePlan {
  const source = parseRows(input.source);
  const destination = parseRows(input.destination);
  snapshotFromRows(source);
  snapshotFromRows(destination);
  if (source.memory_store_identity[0]?.incarnation === destination.memory_store_identity[0]?.incarnation) fail('Source and destination store incarnations must differ');
  assertDisjoint(source, destination);
  const memoryRevisions = new Map(destination.project_memory_revisions.map(row => [textField(row, 'project'), Number(row.revision)]));
  for (const memory of source.memories) {
    const project = textField(memory, 'project'); const revision = (memoryRevisions.get(project) ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) fail('Destination memory revision cannot increase'); memoryRevisions.set(project, revision);
  }
  const merged: Rows = {
    issues: [...source.issues, ...destination.issues],
    comments: [...source.comments, ...destination.comments],
    counters: [...source.counters, ...destination.counters],
    requests: [...source.requests, ...destination.requests],
    memories: [...source.memories, ...destination.memories],
    memory_counters: [...source.memory_counters, ...destination.memory_counters],
    memory_requests: [...source.memory_requests, ...destination.memory_requests],
    dependencies: [...source.dependencies, ...destination.dependencies], dependency_revisions: [...source.dependency_revisions, ...destination.dependency_revisions], dependency_requests: [...source.dependency_requests, ...destination.dependency_requests],
    issue_claims: [...source.issue_claims, ...destination.issue_claims], claim_requests: [...source.claim_requests, ...destination.claim_requests],
    memory_store_identity: destination.memory_store_identity,
    project_memory_revisions: [...memoryRevisions].map(([project, revision]) => ({ project, revision })),
  };
  const expectedSnapshot = snapshotFromRows(merged);
  const canonical = canonicalSnapshot(expectedSnapshot);
  const statements = [schemaGuard(), ...destinationGuards(destination), ...sourceInserts(source)];
  return {
    statements,
    expectedSnapshot,
    digest: createHash('sha256').update(canonical).digest('hex'),
    counts: { added: { ...counts(source), memory_store_identity: 0, project_memory_revisions: merged.project_memory_revisions.length - destination.project_memory_revisions.length }, total: counts(merged) },
  };
}

type DmlOperation = 'INSERT' | 'UPDATE' | 'DELETE';

function retirementSql(table: Table | 'memory_store_identity' | 'project_memory_revisions', operation: DmlOperation, connectionName: string): string {
  const triggerName = quoteIdentifier(`polylinedb_retired_${table}_${operation.toLowerCase()}`);
  const message = `This local database is retired. Use cloud connection ${connectionName}.`.replaceAll("'", "''");
  return `CREATE TRIGGER ${triggerName} BEFORE ${operation} ON ${quoteIdentifier(table)} BEGIN SELECT RAISE(ABORT, '${message}'); END`;
}

export function retireSource(database: DatabaseSync, connectionName: string): void {
  if (typeof connectionName !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(connectionName)) fail('Invalid cloud connection name');
  if (!database.isTransaction) fail('Source retirement requires a caller-owned transaction');
  for (const table of tables) for (const operation of ['INSERT', 'UPDATE', 'DELETE'] as const) {
    const sql = retirementSql(table, operation, connectionName);
    const triggerName = `polylinedb_retired_${table}_${operation.toLowerCase()}`;
    const existing = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(triggerName);
    if (existing) {
      if (existing.sql !== sql) fail('Existing source retirement trigger differs');
      continue;
    }
    database.exec(sql);
  }
}
