// Owns additive D1 merge planning and local source retirement. Remote selection and execution stay outside.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { commentRow, issueRow } from '../src/issues.ts';
import { issueSortKey } from '../src/issue-id.ts';
import { fields, SCHEMA_SQL, SCHEMA_VERSION } from '../src/schema.ts';
import { memoryRow, memorySortKey } from '../src/memories.ts';
import { canonicalSnapshot, parseSnapshot } from '../src/snapshot.ts';
import type { Snapshot } from '../src/snapshot.ts';

export const tables = ['issues', 'comments', 'counters', 'requests', 'memories', 'memory_counters', 'memory_requests'] as const;
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
  if (Object.keys(input).sort().join('\0') !== [...tables].sort().join('\0')) fail('Raw rows must contain all seven canonical collections');
  return {
    issues: parseCollection(input.issues, 'issues'),
    comments: parseCollection(input.comments, 'comments'),
    counters: parseCollection(input.counters, 'counters'),
    requests: parseCollection(input.requests, 'requests'),
    memories: parseCollection(input.memories, 'memories'),
    memory_counters: parseCollection(input.memory_counters, 'memory_counters'),
    memory_requests: parseCollection(input.memory_requests, 'memory_requests'),
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
  return row;
}

function rowsFromSnapshot(snapshot: Snapshot): Rows {
  return {
    issues: snapshot.issues.map(issueRowFromSnapshot),
    comments: snapshot.comments.map(row => ({ ...row })),
    counters: snapshot.counters.map(row => ({ ...row })),
    requests: snapshot.requests.map(row => ({ ...row })),
    memories: snapshot.memories.map(memory => ({ ...memory, sort_key: memorySortKey(memory.id) })),
    memory_counters: snapshot.memory_counters.map(row => ({ ...row })),
    memory_requests: snapshot.memory_requests.map(row => ({ ...row })),
  };
}

function rowKey(row: Row, table: Table): string {
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
  const snapshot = parseSnapshot({
    format: 'polylinedb.snapshot',
    version: 3,
    issues: rows.issues.map(issueRow),
    comments: rows.comments.map(commentRow),
    counters: rows.counters,
    requests: rows.requests,
    memories: rows.memories.map(memoryRow),
    memory_counters: rows.memory_counters,
    memory_requests: rows.memory_requests,
  });
  assertCanonicalRows(rows, rowsFromSnapshot(snapshot));
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
    disjointValues(source[table].map(row => rowKey(row, table)), destination[table].map(row => rowKey(row, table)), `Source and destination share a ${table} key`);
  }
}

function compareBinaryText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

function orderedRows(rows: readonly Row[], table: Table): Row[] {
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
    sql: 'INSERT INTO schema_version(version) SELECT 0 WHERE (SELECT COUNT(*) FROM schema_version) <> 1 OR NOT EXISTS (SELECT 1 FROM schema_version WHERE version = 3)',
    params: [],
  });
}

function destinationGuard(table: Table, chunk: { rows: Row[]; json: string }, lower: string | undefined, upper: string | undefined): Statement {
  const fieldList = columns[table].map(quoteIdentifier).join(', ');
  const jsonFields = columns[table].map(column => `json_extract(entry.value, '$.${column}') AS ${quoteIdentifier(column)}`).join(', ');
  const key = quoteIdentifier(primaryKey[table]);
  const conditions = [lower === undefined ? '' : ` AND ${key} > ?`, upper === undefined ? '' : ` AND ${key} <= ?`].join('');
  const predicates = [lower, upper].filter((value): value is string => value !== undefined);
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
    sql: `INSERT INTO ${quoteIdentifier(table)}(${fieldList}) SELECT ${jsonFields} FROM json_each(?) AS entry`,
    params: [chunk.json],
  });
}

function sourceInserts(rows: Rows): Statement[] {
  const statements: Statement[] = [];
  for (const table of tables) {
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
  };
}

export function additiveMerge(input: { source: unknown; destination: unknown }): MergePlan {
  const schemaVersion: number = SCHEMA_VERSION;
  if (schemaVersion !== 3) fail('Additive merge requires canonical schema version 3');
  const source = parseRows(input.source);
  const destination = parseRows(input.destination);
  snapshotFromRows(source);
  snapshotFromRows(destination);
  assertDisjoint(source, destination);
  const merged: Rows = {
    issues: [...source.issues, ...destination.issues],
    comments: [...source.comments, ...destination.comments],
    counters: [...source.counters, ...destination.counters],
    requests: [...source.requests, ...destination.requests],
    memories: [...source.memories, ...destination.memories],
    memory_counters: [...source.memory_counters, ...destination.memory_counters],
    memory_requests: [...source.memory_requests, ...destination.memory_requests],
  };
  const expectedSnapshot = snapshotFromRows(merged);
  const canonical = canonicalSnapshot(expectedSnapshot);
  const statements = [schemaGuard(), ...destinationGuards(destination), ...sourceInserts(source)];
  return {
    statements,
    expectedSnapshot,
    digest: createHash('sha256').update(canonical).digest('hex'),
    counts: { added: counts(source), total: counts(merged) },
  };
}

type DmlOperation = 'INSERT' | 'UPDATE' | 'DELETE';

function retirementSql(table: Table, operation: DmlOperation, connectionName: string): string {
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
