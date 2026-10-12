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
const tables = ['issues', 'comments', 'counters', 'requests', 'memories', 'memory_counters', 'memory_requests', 'dependencies', 'dependency_revisions', 'dependency_requests', 'issue_claims', 'claim_requests', 'land_order', 'land_order_revisions', 'land_order_requests', 'issue_resources', 'resource_revisions', 'resource_requests'] as const;
type Table = typeof tables[number];
type Rows = Record<Table, Record<string, unknown>[]>;
const key = { issues: 'id', comments: 'id', counters: 'scope', requests: 'request_id', memories: 'id', memory_counters: 'prefix', memory_requests: 'request_id', dependencies: 'dependent_id,blocker_id', dependency_revisions: 'dependent_id', dependency_requests: 'request_id', issue_claims: 'issue_id', claim_requests: 'request_id',
  land_order: 'later_id,earlier_id', land_order_revisions: 'later_id', land_order_requests: 'request_id',
  issue_resources: 'issue_id,seq', resource_revisions: 'issue_id', resource_requests: 'request_id' };
// An edge table has no single-column key, so it is keyed and paged by both endpoints.
const edgeColumns: Partial<Record<Table, readonly [string, string]>> = { dependencies: ['dependent_id', 'blocker_id'], land_order: ['later_id', 'earlier_id'] };
const edgeNames: Partial<Record<Table, string>> = { dependencies: 'dependency', land_order: 'land-order' };
function rowKey(row: Record<string, unknown>, table: Table) {
  if (table === 'issue_resources') return JSON.stringify([row.issue_id, row.seq]);
  const edge = edgeColumns[table]; return edge ? JSON.stringify([row[edge[0]], row[edge[1]]]) : row[key[table]];
}
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
        created_at: issue.created_at, created_by: issue.created_by, updated_at: issue.updated_at, updated_by: issue.updated_by, closed_at: issue.closed_at, closed_by: issue.closed_by };
    }), comments: snapshot.comments.map(row => ({ ...row })), counters: snapshot.counters.map(row => ({ ...row })), requests: snapshot.requests.map(row => ({ ...row })),
    memories: snapshot.memories.map(row => ({ ...row, sort_key: memorySortKey(row.id) })), memory_counters: snapshot.memory_counters.map(row => ({ ...row })), memory_requests: snapshot.memory_requests.map(row => ({ ...row })),
    dependencies: snapshot.dependencies.map(row => ({ ...row })), dependency_revisions: snapshot.dependency_revisions.map(row => ({ ...row })), dependency_requests: snapshot.dependency_requests.map(row => ({ ...row })),
    issue_claims: snapshot.issue_claims.map(row => ({ ...row })), claim_requests: snapshot.claim_requests.map(row => ({ ...row })),
    land_order: snapshot.land_order.map(row => ({ ...row })), land_order_revisions: snapshot.land_order_revisions.map(row => ({ ...row })), land_order_requests: snapshot.land_order_requests.map(row => ({ ...row })),
    issue_resources: snapshot.issue_resources.map(row => ({ ...row })), resource_revisions: snapshot.resource_revisions.map(row => ({ ...row })), resource_requests: snapshot.resource_requests.map(row => ({ ...row })),
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
  const rows: Rows = { issues: [], comments: [], counters: [], requests: [], memories: [], memory_counters: [], memory_requests: [], dependencies: [], dependency_revisions: [], dependency_requests: [], issue_claims: [], claim_requests: [], land_order: [], land_order_revisions: [], land_order_requests: [], issue_resources: [], resource_revisions: [], resource_requests: [] };
  // Large text records use one-row pages because a valid body can approach the response limit.
  for (const table of tables) {
    if (table === 'issue_resources') {
      // An entry is keyed by its issue and a number, so it pages in issue order, then by number.
      let after: [string, number] | undefined;
      for (;;) {
        const page = await querySql(query, `SELECT issue_resources.*, owner.sort_key AS owner_sort FROM issue_resources LEFT JOIN issues AS owner ON owner.id = issue_resources.issue_id ${after === undefined ? '' : 'WHERE (owner.sort_key,issue_resources.seq) > (?,?)'} ORDER BY owner.sort_key,issue_resources.seq LIMIT 1`, after ?? []);
        const row = page[0]; if (!row) break;
        const { owner_sort: ownerSort, ...entry } = row;
        if (page.length !== 1 || typeof ownerSort !== 'string' || typeof entry.seq !== 'number') return fail('Invalid resource entry page');
        const next: [string, number] = [ownerSort, entry.seq];
        if (after && (next[0] < after[0] || (next[0] === after[0] && next[1] <= after[1]))) fail('The resource entry cursor did not advance');
        after = next; rows[table].push(entry);
      }
      continue;
    }
    const edge = edgeColumns[table];
    if (edge) {
      const [first, second] = edge;
      let after: [string, string] | undefined;
      for (;;) {
        const page = await querySql(query, `SELECT ${table}.*, first.sort_key AS first_sort, second.sort_key AS second_sort FROM ${table} LEFT JOIN issues AS first ON first.id = ${first} LEFT JOIN issues AS second ON second.id = ${second} ${after === undefined ? '' : 'WHERE (first.sort_key,second.sort_key) > (?,?)'} ORDER BY first.sort_key,second.sort_key LIMIT 1`, after ?? []);
        const row = page[0]; if (!row) break;
        const firstSort = row.first_sort; const secondSort = row.second_sort;
        if (page.length !== 1 || typeof firstSort !== 'string' || typeof secondSort !== 'string') return fail(`Invalid ${edgeNames[table]} tuple page`);
        const next: [string, string] = [firstSort, secondSort];
        if (after && (next[0] < after[0] || (next[0] === after[0] && next[1] <= after[1]))) fail(`The ${edgeNames[table]} cursor did not advance`);
        after = next; rows[table].push({ [first]: row[first], [second]: row[second] });
      }
      continue;
    }
    let after: string | undefined;
    for (;;) {
      const limit = table === 'issue_claims' || table === 'claim_requests' || table === 'land_order_revisions' || table === 'resource_revisions' ? 100 : 1;
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
    if (complete && claims.length === 1) {
      const identity = (await querySql(query, 'SELECT incarnation FROM memory_store_identity WHERE singleton=1'))[0];
      if (identity?.incarnation !== claims[0]?.incarnation) fail('Completed restore incarnation differs from the recorded target');
    }
    const empty = tables.every(table => actual[table].length === 0);
    if (!empty && !complete && claims.length === 0) fail('Partial destination has no snapshot claim');
    return { state: complete ? 'identical' : empty ? 'empty' : 'resumable', sha256, counts };
  };
  const verify = async () => {
    await inspect();
    const actual = await readRows(query);
    if (!compareRows(rows, actual)) fail('Destination snapshot is incomplete');
    const snapshot = parseSnapshot({ format: 'polylinedb.snapshot', version: 7,
      issues: actual.issues.map(issueRow), comments: actual.comments.map(commentRow), counters: actual.counters, requests: actual.requests,
      memories: actual.memories.map(memoryRow), memory_counters: actual.memory_counters, memory_requests: actual.memory_requests,
      dependencies: actual.dependencies, dependency_revisions: actual.dependency_revisions, dependency_requests: actual.dependency_requests,
      issue_claims: actual.issue_claims.map(claimRow), claim_requests: actual.claim_requests.map(claimRequestRow),
      land_order: actual.land_order, land_order_revisions: actual.land_order_revisions, land_order_requests: actual.land_order_requests,
      issue_resources: actual.issue_resources, resource_revisions: actual.resource_revisions, resource_requests: actual.resource_requests });
    if (canonicalSnapshot(snapshot) !== canonical) fail('Destination canonical snapshot differs');
    const hasClaim = await checkSchema(query);
    if (hasClaim) {
      const target = (await querySql(query, `SELECT incarnation FROM ${claimTable} WHERE singleton=1 AND sha256=?`, [sha256]))[0];
      const identity = (await querySql(query, 'SELECT incarnation FROM memory_store_identity WHERE singleton=1'))[0];
      if (!target || identity?.incarnation !== target.incarnation) fail('Verified restore incarnation differs from the recorded target');
    }
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
