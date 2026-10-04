// Owns operator snapshot claims and exact D1 restoration; domain modules own application operations.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalSnapshot, parseSnapshot } from '../src/snapshot.ts';
import { commentRow, issueRow } from '../src/issues.ts';
import { issueSortKey } from '../src/issue-id.ts';
import { fields, SCHEMA_SQL, SCHEMA_VERSION, ROTATE_MEMORY_IDENTITY_SQL } from '../src/schema.ts';
import { memoryRow, memorySortKey } from '../src/memories.ts';

export type Statement = { sql: string; params: (string | number | null)[] };
export type Query = (statement: Statement) => Promise<Record<string, unknown>[]>;
const claimTable = 'polylinedb_snapshot_claim';
const claimSql = `CREATE TABLE ${claimTable} (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), sha256 TEXT NOT NULL)`;
const tables = ['issues', 'comments', 'counters', 'requests', 'memories', 'memory_counters', 'memory_requests'] as const;
type Table = typeof tables[number];
type Rows = Record<Table, Record<string, unknown>[]>;
const key = { issues: 'id', comments: 'id', counters: 'scope', requests: 'request_id', memories: 'id', memory_counters: 'prefix', memory_requests: 'request_id' };
const fail = (message: string): never => { throw new Error(message); };
const querySql = (query: Query, sql: string, params: Statement['params'] = []) => query({ sql, params });
const digest = (canonical: string) => createHash('sha256').update(canonical).digest('hex');
const ordered = (row: Record<string, unknown>) => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));

function expectedRows(input: unknown): { canonical: string; rows: Rows } {
  const snapshot = parseSnapshot(input);
  return { canonical: canonicalSnapshot(snapshot), rows: {
    issues: [...snapshot.issues].sort((a, b) => a.id.split('.').length - b.id.split('.').length).map(issue => {
      const split = issue.id.lastIndexOf('.');
      return { id: issue.id, parent_id: split < 0 ? null : issue.id.slice(0, split), sort_key: issueSortKey(issue.id),
        ...Object.fromEntries(fields.map(field => [field === 'labels' ? 'labels_json' : field, field === 'labels' ? JSON.stringify(issue.labels) : issue[field]])),
        ...Object.fromEntries(fields.map(field => [`${field}_v`, issue.versions[field]])),
        created_at: issue.created_at, created_by: issue.created_by, updated_at: issue.updated_at, updated_by: issue.updated_by };
    }), comments: snapshot.comments.map(row => ({ ...row })), counters: snapshot.counters.map(row => ({ ...row })), requests: snapshot.requests.map(row => ({ ...row })),
    memories: snapshot.memories.map(row => ({ ...row, sort_key: memorySortKey(row.id) })), memory_counters: snapshot.memory_counters.map(row => ({ ...row })), memory_requests: snapshot.memory_requests.map(row => ({ ...row })),
  } };
}

async function checkSchema(query: Query): Promise<boolean> {
  const reference = new DatabaseSync(':memory:');
  const sql = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_METADATA', '_cf_KV') ORDER BY name";
  try {
    reference.exec(SCHEMA_SQL);
    const expected = reference.prepare(sql).all();
    const actual = await querySql(query, sql);
    const claim = actual.find(row => row.name === claimTable);
    if (JSON.stringify(actual.filter(row => row.name !== claimTable).map(ordered)) !== JSON.stringify(expected.map(ordered))) fail('Destination must have the canonical polylinedb schema');
    if (claim) {
      reference.exec(claimSql);
      const expectedClaim = reference.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name = ?').get(claimTable);
      if (!expectedClaim || ordered(claim) !== ordered(expectedClaim)) fail('Destination claim schema differs');
    }
    const versions = await querySql(query, 'SELECT version FROM schema_version');
    if (versions.length !== 1 || versions[0]?.version !== SCHEMA_VERSION) fail('Destination schema version differs');
    return claim !== undefined;
  } finally { reference.close(); }
}

async function readRows(query: Query): Promise<Rows> {
  const rows: Rows = { issues: [], comments: [], counters: [], requests: [], memories: [], memory_counters: [], memory_requests: [] };
  // One-row pages also bound responses when a valid body approaches the row limit.
  for (const table of tables) {
    let after: string | undefined;
    for (;;) {
      const page = await querySql(query, `SELECT * FROM ${table}${after === undefined ? '' : ` WHERE ${key[table]} > ?`} ORDER BY ${key[table]} LIMIT 1`, after === undefined ? [] : [after]);
      if (page.length === 0) break;
      const row = page[0];
      if (page.length !== 1 || !row || typeof row[key[table]] !== 'string') fail('Invalid destination page');
      const next = row[key[table]];
      if (typeof next !== 'string') return fail('Invalid destination cursor');
      if (after !== undefined && next <= after) fail('Destination cursor did not advance');
      after = next;
      rows[table].push(row);
    }
  }
  return rows;
}

function compareRows(expected: Rows, actual: Rows): boolean {
  let complete = true;
  for (const table of tables) {
    const byId = new Map(expected[table].map(row => [row[key[table]], ordered(row)]));
    for (const row of actual[table]) if (byId.get(row[key[table]]) !== ordered(row)) fail(`Destination ${table} contains unexpected or differing rows`);
    if (actual[table].length !== expected[table].length) complete = false;
  }
  return complete;
}

export function snapshotMigration(query: Query, input: unknown, expectedDigest: string) {
  const { canonical, rows } = expectedRows(input);
  const sha256 = digest(canonical);
  if (!/^[a-f0-9]{64}$/.test(expectedDigest) || sha256 !== expectedDigest) fail('Snapshot digest differs from the fixed target');
  const counts = Object.fromEntries(tables.map(table => [table, rows[table].length]));
  for (const table of tables) for (const row of rows[table]) {
    if (Buffer.byteLength(JSON.stringify(row)) > 1_900_000) fail('Snapshot row exceeds the operator transfer limit');
  }
  const inspect = async () => {
    const hasClaim = await checkSchema(query);
    const claims = hasClaim ? await querySql(query, `SELECT singleton,sha256 FROM ${claimTable}`) : [];
    if (claims.length > 1 || (claims.length === 1 && (claims[0]?.singleton !== 1 || claims[0]?.sha256 !== sha256))) fail('Destination belongs to another snapshot');
    const actual = await readRows(query);
    const complete = compareRows(rows, actual);
    const empty = tables.every(table => actual[table].length === 0);
    if (!empty && !complete && claims.length === 0) fail('Partial destination has no snapshot claim');
    return { state: complete ? 'identical' : empty ? 'empty' : 'resumable', sha256, counts };
  };
  const verify = async () => {
    await inspect();
    const actual = await readRows(query);
    if (!compareRows(rows, actual)) fail('Destination snapshot is incomplete');
    const snapshot = parseSnapshot({ format: 'polylinedb.snapshot', version: 3,
      issues: actual.issues.map(issueRow), comments: actual.comments.map(commentRow), counters: actual.counters, requests: actual.requests,
      memories: actual.memories.map(memoryRow), memory_counters: actual.memory_counters, memory_requests: actual.memory_requests });
    if (canonicalSnapshot(snapshot) !== canonical) fail('Destination canonical snapshot differs');
    return { result: 'verified', sha256, counts, snapshot };
  };
  const restore = async () => {
    const before = await inspect();
    if (before.state === 'identical') return { ...await verify(), result: 'already_present' };
    await querySql(query, claimSql.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '));
    await querySql(query, `INSERT INTO ${claimTable}(singleton,sha256) SELECT 1,? WHERE ${tables.map(table => `NOT EXISTS (SELECT 1 FROM ${table})`).join(' AND ')} ON CONFLICT(singleton) DO NOTHING`, [sha256]);
    const claim = await querySql(query, `SELECT singleton,sha256 FROM ${claimTable}`);
    if (claim.length !== 1 || claim[0]?.singleton !== 1 || claim[0]?.sha256 !== sha256) fail('Destination snapshot claim was refused');
    await querySql(query, ROTATE_MEMORY_IDENTITY_SQL);
    for (const table of tables) for (const row of rows[table]) {
      const columns = Object.keys(row);
      const params = Object.values(row).map(value => {
        if (value === null || typeof value === 'string' || typeof value === 'number') return value;
        return fail('Invalid snapshot SQL value');
      });
      await querySql(query, `INSERT INTO ${table}(${columns.join(',')}) SELECT ${columns.map(() => '?').join(',')} WHERE EXISTS (SELECT 1 FROM ${claimTable} WHERE singleton = 1 AND sha256 = ?) ON CONFLICT(${key[table]}) DO NOTHING`, [...params, sha256]);
    }
    return { ...await verify(), result: 'restored' };
  };
  return { inspect, restore, verify };
}
