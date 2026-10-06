// Owns operator snapshot claims and exact D1 restoration; domain modules own application operations.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalSnapshot, parseSnapshot } from '../src/records/persistence.ts';
import { commentRow, issueRow } from '../src/records/persistence.ts';
import { issueSortKey } from '../src/records/persistence.ts';
import { fields, SCHEMA_SQL, SCHEMA_VERSION } from '../src/records/persistence.ts';
import { memoryRow, memorySortKey } from '../src/records/persistence.ts';
import { claimRow, claimRequestRow } from '../src/records/persistence.ts';

export type Statement = { sql: string; params: (string | number | null)[] };
export type Query = (statement: Statement) => Promise<Record<string, unknown>[]>;
const claimTable = 'polylinedb_snapshot_claim';
const claimSql = `CREATE TABLE ${claimTable} (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), sha256 TEXT NOT NULL, original_incarnation TEXT NOT NULL, incarnation TEXT NOT NULL CHECK(length(incarnation)=32 AND incarnation NOT GLOB '*[^a-f0-9]*' AND incarnation<>original_incarnation))`;
const tables = ['issues', 'comments', 'counters', 'requests', 'memories', 'memory_counters', 'memory_requests', 'dependencies', 'dependency_revisions', 'dependency_requests', 'issue_claims', 'claim_requests'] as const;
type Table = typeof tables[number];
type Rows = Record<Table, Record<string, unknown>[]>;
const key = { issues: 'id', comments: 'id', counters: 'scope', requests: 'request_id', memories: 'id', memory_counters: 'prefix', memory_requests: 'request_id', dependencies: 'dependent_id,blocker_id', dependency_revisions: 'dependent_id', dependency_requests: 'request_id', issue_claims: 'issue_id', claim_requests: 'request_id' };
function rowKey(row: Record<string, unknown>, table: Table) { return table === 'dependencies' ? JSON.stringify([row.dependent_id, row.blocker_id]) : row[key[table]]; }
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
    dependencies: snapshot.dependencies.map(row => ({ ...row })), dependency_revisions: snapshot.dependency_revisions.map(row => ({ ...row })), dependency_requests: snapshot.dependency_requests.map(row => ({ ...row })),
    issue_claims: snapshot.issue_claims.map(row => ({ ...row })), claim_requests: snapshot.claim_requests.map(row => ({ ...row })),
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
  const rows: Rows = { issues: [], comments: [], counters: [], requests: [], memories: [], memory_counters: [], memory_requests: [], dependencies: [], dependency_revisions: [], dependency_requests: [], issue_claims: [], claim_requests: [] };
  // One-row pages also bound responses when a valid body approaches the row limit.
  for (const table of tables) {
    if (table === 'dependencies') {
      let after: [string, string] | undefined;
      for (;;) {
        const page = await querySql(query, `SELECT dependencies.*, dependent.sort_key AS dependent_sort, blocker.sort_key AS blocker_sort FROM dependencies LEFT JOIN issues AS dependent ON dependent.id = dependent_id LEFT JOIN issues AS blocker ON blocker.id = blocker_id ${after === undefined ? '' : 'WHERE (dependent.sort_key,blocker.sort_key) > (?,?)'} ORDER BY dependent.sort_key,blocker.sort_key LIMIT 1`, after ?? []);
        const row = page[0]; if (!row) break;
        const dependentSort = row.dependent_sort; const blockerSort = row.blocker_sort;
        if (page.length !== 1 || typeof dependentSort !== 'string' || typeof blockerSort !== 'string') return fail('Invalid dependency tuple page');
        const next: [string, string] = [dependentSort, blockerSort];
        if (after && (next[0] < after[0] || (next[0] === after[0] && next[1] <= after[1]))) fail('Dependency cursor did not advance');
        after = next; rows.dependencies.push({ dependent_id: row.dependent_id, blocker_id: row.blocker_id });
      }
      continue;
    }
    let after: string | undefined;
    for (;;) {
      const limit = table === 'issue_claims' || table === 'claim_requests' ? 100 : 1;
      const page = await querySql(query, `SELECT * FROM ${table}${after === undefined ? '' : ` WHERE ${key[table]} > ?`} ORDER BY ${key[table]} LIMIT ${limit}`, after === undefined ? [] : [after]);
      if (page.length === 0) break;
      if (page.length > limit) fail('Invalid destination page');
      for (const row of page) {
        const next = row[key[table]];
        if (typeof next !== 'string') return fail('Invalid destination cursor');
        if (after !== undefined && next <= after) fail('Destination cursor did not advance');
        after = next; rows[table].push(row);
      }
    }
  }
  return rows;
}

function compareRows(expected: Rows, actual: Rows, allowBaselines = false): boolean {
  let complete = true;
  for (const table of tables) {
    const byId = new Map(expected[table].map(row => [rowKey(row, table), row]));
    for (const row of actual[table]) {
      const expectedRow = byId.get(rowKey(row, table));
      if (expectedRow && ordered(expectedRow) === ordered(row)) continue;
      if (allowBaselines && table === 'dependency_revisions' && expectedRow && row.revision === 1) { complete = false; continue; }
      fail(`Destination ${table} contains unexpected or differing rows`);
    }
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
    const claims = hasClaim ? await querySql(query, `SELECT * FROM ${claimTable}`) : [];
    if (claims.length > 1 || (claims.length === 1 && (claims[0]?.singleton !== 1 || claims[0]?.sha256 !== sha256))) fail('Destination belongs to another snapshot');
    if (claims.length === 1) {
      const identity = (await querySql(query, 'SELECT incarnation FROM memory_store_identity WHERE singleton=1'))[0];
      if (!identity || (identity.incarnation !== claims[0]?.incarnation && identity.incarnation !== claims[0]?.original_incarnation)) fail('Destination incarnation differs from the durable restore claim');
    }
    const actual = await readRows(query);
    const complete = compareRows(rows, actual, claims.length === 1);
    const empty = tables.every(table => actual[table].length === 0);
    if (!empty && !complete && claims.length === 0) fail('Partial destination has no snapshot claim');
    return { state: complete ? 'identical' : empty ? 'empty' : 'resumable', sha256, counts };
  };
  const verify = async () => {
    await inspect();
    const actual = await readRows(query);
    if (!compareRows(rows, actual)) fail('Destination snapshot is incomplete');
    const snapshot = parseSnapshot({ format: 'polylinedb.snapshot', version: 5,
      issues: actual.issues.map(issueRow), comments: actual.comments.map(commentRow), counters: actual.counters, requests: actual.requests,
      memories: actual.memories.map(memoryRow), memory_counters: actual.memory_counters, memory_requests: actual.memory_requests,
      dependencies: actual.dependencies, dependency_revisions: actual.dependency_revisions, dependency_requests: actual.dependency_requests,
      issue_claims: actual.issue_claims.map(claimRow), claim_requests: actual.claim_requests.map(claimRequestRow) });
    if (canonicalSnapshot(snapshot) !== canonical) fail('Destination canonical snapshot differs');
    return { result: 'verified', sha256, counts, snapshot };
  };
  const restore = async () => {
    const before = await inspect();
    if (before.state === 'identical') return { ...await verify(), result: 'already_present' };
    await querySql(query, claimSql.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS '));
    await querySql(query, `INSERT INTO ${claimTable}(singleton,sha256,original_incarnation,incarnation) SELECT 1,?,incarnation,lower(hex(randomblob(16))) FROM memory_store_identity WHERE singleton=1 AND ${tables.map(table => `NOT EXISTS (SELECT 1 FROM ${table})`).join(' AND ')} ON CONFLICT(singleton) DO NOTHING`, [sha256]);
    const claim = await querySql(query, `SELECT * FROM ${claimTable}`);
    if (claim.length !== 1 || claim[0]?.singleton !== 1 || claim[0]?.sha256 !== sha256) fail('Destination snapshot claim was refused');
    await querySql(query, `UPDATE memory_store_identity SET incarnation=(SELECT incarnation FROM ${claimTable} WHERE singleton=1 AND sha256=?) WHERE singleton=1 AND incarnation=(SELECT original_incarnation FROM ${claimTable} WHERE singleton=1 AND sha256=?)`, [sha256, sha256]);
    const identity = (await querySql(query, 'SELECT incarnation FROM memory_store_identity WHERE singleton=1'))[0];
    if (identity?.incarnation !== claim[0]?.incarnation) fail('Destination incarnation differs from the durable restore claim');
    for (const table of tables) for (const row of rows[table]) {
      const columns = Object.keys(row);
      const params = Object.values(row).map(value => {
        if (value === null || typeof value === 'string' || typeof value === 'number') return value;
        return fail('Invalid snapshot SQL value');
      });
      await querySql(query, `INSERT INTO ${table}(${columns.join(',')}) SELECT ${columns.map(() => '?').join(',')} WHERE EXISTS (SELECT 1 FROM ${claimTable} WHERE singleton = 1 AND sha256 = ?) ON CONFLICT(${key[table]}) ${table === 'dependency_revisions' ? 'DO UPDATE SET revision = excluded.revision WHERE dependency_revisions.revision = 1' : 'DO NOTHING'}`, [...params, sha256]);
    }
    return { ...await verify(), result: 'restored' };
  };
  return { inspect, restore, verify };
}
