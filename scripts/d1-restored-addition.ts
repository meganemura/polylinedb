// Owns one addition of local records to an unchanged restored D1 store, through source retirement.
// It does not change repository routing. A release 0.1.0 checkpoint qualifies only after the schema 3 to 6 upgrade.
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, writeSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { additiveMerge, rawToSnapshot, retireSource, tables } from './d1-additive-merge.ts';
import type { Counts, Statement } from './d1-additive-merge.ts';
import { canonicalSnapshot, canonicalSnapshotV3, convertSnapshotV3, parseSnapshot, SCHEMA_SQL, SCHEMA_VERSION } from '../src/records/persistence.ts';

export type Batch = (statements: readonly Statement[]) => Promise<readonly (readonly Record<string, unknown>[])[]>;
export type AdditionOutcome = { outcome: 'retired'; operation_id: string; expected_sha256: string; counts: Counts };

/** Evidence proves that the addition must not proceed from this state. */
export class AdditionRefused extends Error { override name = 'AdditionRefused'; }
/** Evidence is unavailable or contradictory, so the addition may or may not have committed. */
export class AdditionUnknown extends Error { override name = 'AdditionUnknown'; }

type Digest<Kind extends string> = string & { readonly digest: Kind };
type OriginalDigest = Digest<'original'>;
type BaselineDigest = Digest<'baseline'>;
type FrozenDigest = Digest<'frozen'>;
type SourceDigest = Digest<'source'>;
type RawRows = Record<string, Record<string, unknown>[]>;
type SchemaEntry = { type: unknown; name: unknown; tbl_name: unknown; sql: unknown };

const claimTable = 'polylinedb_snapshot_claim';
const archiveTable = 'polylinedb_snapshot_claim_archive';
const receiptTable = 'polylinedb_addition_receipt';
const schemaSql = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_METADATA','_cf_KV') ORDER BY name";
// Workers Paid permits 1,000 queries per invocation; Free permits 50. A larger packet is refused, never split.
const maximumStatementLimit = 1000;

type Checkpoint = Record<string, string | 1> & { singleton: 1; sha256: string };
/** The original input as the restore checkpoint digested it, and as the schema 6 rows that restoration leaves. */
type OriginalForms = { canonical: string; projected: string };
type CheckpointLayout = {
  ddl: string;
  /** In table order, which the barrier view keeps. */
  columns: readonly string[];
  snapshotVersion: number;
  original(input: unknown): OriginalForms;
  valid(row: Record<string, unknown>): boolean;
  /** The destination incarnation that the checkpoint records, when the layout records one. */
  target(checkpoint: Checkpoint): string | undefined;
};

const checkpointLayouts = {
  // Release 0.1.0 restored snapshot 3 into schema 3. The schema 3 to 6 upgrade leaves what convertSnapshotV3 produces in the 12 application tables.
  'two-column': {
    ddl: `CREATE TABLE ${claimTable} (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), sha256 TEXT NOT NULL)`,
    columns: ['singleton', 'sha256'],
    snapshotVersion: 3,
    original: input => ({ canonical: canonicalSnapshotV3(input), projected: canonicalSnapshot(convertSnapshotV3(input)) }),
    valid: () => true,
    target: () => undefined,
  },
  'four-column': {
    ddl: `CREATE TABLE ${claimTable} (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), sha256 TEXT NOT NULL, original_incarnation TEXT NOT NULL, incarnation TEXT NOT NULL CHECK(length(incarnation)=32 AND incarnation NOT GLOB '*[^a-f0-9]*' AND incarnation<>original_incarnation))`,
    columns: ['singleton', 'sha256', 'original_incarnation', 'incarnation'],
    snapshotVersion: 5,
    original(input) { const canonical = canonicalSnapshot(parseSnapshot(input)); return { canonical, projected: canonical }; },
    valid: row => hexIncarnation(row.original_incarnation) && hexIncarnation(row.incarnation) && row.original_incarnation !== row.incarnation,
    target: checkpoint => String(checkpoint.incarnation),
  },
} satisfies Record<string, CheckpointLayout>;
type Layout = keyof typeof checkpointLayouts;
const layouts = Object.keys(checkpointLayouts) as Layout[];

const receiptColumns = ['singleton', 'operation_id', 'frozen_sha256', 'destination_incarnation', 'checkpoint_layout', 'original_sha256', 'baseline_sha256', 'expected_sha256', 'counts_json'] as const;
type Receipt = { [Column in typeof receiptColumns[number]]: Column extends 'singleton' ? 1 : string };
const receiptSchema = [
  `CREATE TABLE ${receiptTable} (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), ${receiptColumns.slice(1).map(column => `${column} TEXT NOT NULL`).join(', ')})`,
  ...(['UPDATE', 'DELETE'] as const).map(event => `CREATE TRIGGER ${receiptTable}_immutable_${event.toLowerCase()} BEFORE ${event} ON ${receiptTable} BEGIN SELECT RAISE(ABORT, 'The addition receipt is immutable'); END`),
];
const barrier = (layout: Layout) => [
  `ALTER TABLE ${claimTable} RENAME TO ${archiveTable}`,
  `CREATE VIEW ${claimTable} AS SELECT ${checkpointLayouts[layout].columns.join(', ')} FROM ${archiveTable} WHERE 0`,
];

const refuse = (message: string): never => { throw new AdditionRefused(message); };
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const hexIncarnation = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable((value as Record<string, unknown>)[key])]));
  return value;
}
const stableJson = (value: unknown) => JSON.stringify(stable(value));

function normalizedRows(rows: RawRows): RawRows {
  return Object.fromEntries(tables.map(table => [table, (rows[table] ?? []).map(row => stable(row) as Record<string, unknown>).sort((left, right) => {
    const a = JSON.stringify(left); const b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  })]));
}

function profileSchema(statements: readonly string[]): string {
  const reference = new DatabaseSync(':memory:');
  try {
    reference.exec(SCHEMA_SQL);
    for (const statement of statements) reference.exec(statement);
    return stableJson(reference.prepare(schemaSql).all());
  } finally { reference.close(); }
}
type Profile = { kind: 'restored' | 'terminal'; layout: Layout };
const profiles = new Map(layouts.flatMap((layout): [string, Profile][] => [
  [profileSchema([checkpointLayouts[layout].ddl]), { kind: 'restored', layout }],
  [profileSchema([checkpointLayouts[layout].ddl, ...receiptSchema, ...barrier(layout)]), { kind: 'terminal', layout }],
]));

function classifySchema(schema: readonly SchemaEntry[]): Profile {
  return profiles.get(stableJson(schema)) ?? refuse('Destination schema is not canonical schema 6 with a recognized restore checkpoint layout');
}

type Capture = { profile: Profile; schema: SchemaEntry[]; version: unknown; checkpoint: Record<string, unknown>[]; receipt: Record<string, unknown>[]; visibleCheckpoint: Record<string, unknown>[]; rows: RawRows };

async function capture(batch: Batch): Promise<Capture> {
  let results: readonly (readonly Record<string, unknown>[])[];
  let profile: Profile;
  try {
    const [schema] = await batch([{ sql: schemaSql, params: [] }]);
    profile = classifySchema((schema ?? []) as SchemaEntry[]);
    const checkpoint = profile.kind === 'restored' ? claimTable : archiveTable;
    const extra = profile.kind === 'terminal' ? [`SELECT * FROM ${receiptTable}`, `SELECT * FROM ${claimTable}`] : [];
    results = await batch([schemaSql, 'SELECT version FROM schema_version', `SELECT * FROM ${checkpoint}`, ...extra, ...tables.map(table => `SELECT * FROM ${table}`)].map(sql => ({ sql, params: [] })));
  } catch (error) {
    if (error instanceof AdditionRefused) throw error;
    throw new AdditionUnknown('Destination evidence is unavailable');
  }
  const offset = profile.kind === 'terminal' ? 5 : 3;
  if (results.length !== offset + tables.length) throw new AdditionUnknown('Destination returned an unexpected read result');
  const schema = [...(results[0] ?? [])] as SchemaEntry[];
  const current = classifySchema(schema);
  if (stableJson(current) !== stableJson(profile)) throw new AdditionUnknown('Destination schema changed during capture');
  const versions = results[1] ?? [];
  if (versions.length !== 1 || versions[0]?.version !== SCHEMA_VERSION) refuse('Destination schema version differs');
  return {
    profile, schema, version: SCHEMA_VERSION,
    checkpoint: [...(results[2] ?? [])],
    receipt: profile.kind === 'terminal' ? [...(results[3] ?? [])] : [],
    visibleCheckpoint: profile.kind === 'terminal' ? [...(results[4] ?? [])] : [],
    rows: Object.fromEntries(tables.map((table, index) => [table, [...(results[offset + index] ?? [])]])),
  };
}

function restoreCheckpoint(layout: Layout, rows: readonly Record<string, unknown>[]): Checkpoint {
  const { columns, valid } = checkpointLayouts[layout];
  const row = rows[0];
  if (rows.length !== 1 || !row || Object.keys(row).sort().join(',') !== [...columns].sort().join(',')) return refuse('Destination must have exactly one restore checkpoint row');
  if (row.singleton !== 1 || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) return refuse('Restore checkpoint row is invalid');
  if (!valid(row)) return refuse('Restore checkpoint incarnations are invalid');
  return Object.fromEntries(columns.map(column => [column, row[column]])) as Checkpoint;
}

function destinationIncarnation(rows: RawRows): string {
  const identity = rows.memory_store_identity ?? [];
  if (identity.length !== 1 || identity[0]?.singleton !== 1 || !hexIncarnation(identity[0]?.incarnation)) return refuse('Destination store identity is invalid');
  return identity[0].incarnation;
}

function originalInput(text: string, layout: Layout): { projected: string; digest: OriginalDigest } {
  let input: unknown;
  try { input = JSON.parse(text); } catch { return refuse('Original restore input is not JSON'); }
  const declared = input !== null && typeof input === 'object' && 'version' in input ? input.version : undefined;
  if (declared !== checkpointLayouts[layout].snapshotVersion) refuse(`The ${layout} checkpoint requires snapshot format ${checkpointLayouts[layout].snapshotVersion}`);
  let forms: OriginalForms;
  try { forms = checkpointLayouts[layout].original(input); } catch { return refuse('Original restore input is not a valid snapshot'); }
  return { projected: forms.projected, digest: sha256(forms.canonical) as OriginalDigest };
}

// No original input records project_memory_revisions, so it is guarded but not compared. After a schema 3 upgrade, its values also depend on when the upgrade ran.
type Baseline = { layout: Layout; schema: SchemaEntry[]; checkpoint: Checkpoint; incarnation: string; rows: RawRows; originalDigest: OriginalDigest; digest: BaselineDigest };

function restoredBaseline(destination: Capture, originalText: string): Baseline {
  if (destination.profile.kind === 'terminal') return refuse('Destination already recorded an addition; only its recovery is permitted');
  const { layout } = destination.profile;
  const original = originalInput(originalText, layout);
  const checkpoint = restoreCheckpoint(layout, destination.checkpoint);
  if (checkpoint.sha256 !== original.digest) refuse('Restore checkpoint digest differs from the original input');
  const incarnation = destinationIncarnation(destination.rows);
  const target = checkpointLayouts[layout].target(checkpoint);
  if (target !== undefined && target !== incarnation) refuse('Destination identity differs from the restore checkpoint target');
  let restored: string;
  try { restored = canonicalSnapshot(rawToSnapshot(destination.rows)); } catch { return refuse('Destination rows are not a canonical store'); }
  if (restored !== original.projected) refuse('Destination rows differ from the original restore input');
  const rows = normalizedRows(destination.rows);
  return { layout, schema: destination.schema, checkpoint, incarnation, rows, originalDigest: original.digest, digest: sha256(stableJson({ schema: destination.schema, version: destination.version, checkpoint, rows })) as BaselineDigest };
}

function guard(condition: string, params: Statement['params']): Statement {
  return { sql: `INSERT INTO schema_version(version) SELECT 0 WHERE ${condition}`, params };
}

function barrierGuards(baseline: Baseline): Statement[] {
  const schemaJson = `(SELECT json_group_array(json_object('name',name,'sql',sql,'tbl_name',tbl_name,'type',type)) FROM (${schemaSql}))`;
  const { checkpoint } = baseline;
  const { columns } = checkpointLayouts[baseline.layout];
  return [
    guard(`${schemaJson} IS NOT json(?)`, [JSON.stringify(baseline.schema.map(stable))]),
    guard(`(SELECT COUNT(*) FROM ${claimTable}) <> 1 OR NOT EXISTS (SELECT 1 FROM ${claimTable} WHERE ${columns.map(column => `${column} = ?`).join(' AND ')})`, columns.map(column => checkpoint[column] ?? null)),
  ];
}

type Operation = {
  format: 'polylinedb.restored-addition'; version: 1;
  operation_id: string; connection: string; source_path: string;
  original: string; baseline: Baseline; source_rows: RawRows; source_sha256: SourceDigest;
  receipt: Receipt; statements: Statement[]; expected: string; counts: Counts;
};

function frozenDigest(operationId: string, baseline: Baseline, source: SourceDigest, additions: readonly Statement[]): FrozenDigest {
  return sha256(stableJson({ operation_id: operationId, original: baseline.originalDigest, baseline: baseline.digest, source, statements: additions })) as FrozenDigest;
}

function packetEnd(receipt: Receipt): Statement[] {
  return [
    ...receiptSchema.map(sql => ({ sql, params: [] })),
    { sql: `INSERT INTO ${receiptTable}(${receiptColumns.join(',')}) VALUES (${receiptColumns.map(() => '?').join(',')})`, params: receiptColumns.map(column => receipt[column]) },
    ...barrier(receipt.checkpoint_layout as Layout).map(sql => ({ sql, params: [] })),
  ];
}

/** Refuses a journal whose packet, receipt, or frozen inputs no longer match the digest recorded before dispatch. */
function frozenOperation(value: unknown): Operation {
  const operation = value as Operation;
  try {
    if (operation.format !== 'polylinedb.restored-addition' || operation.version !== 1) return refuse('The journal format is not supported');
    const end = packetEnd(operation.receipt);
    const additions = operation.statements.slice(0, operation.statements.length - end.length);
    const source = sha256(stableJson(operation.source_rows)) as SourceDigest;
    if (stableJson(operation.statements.slice(additions.length)) !== stableJson(end) || source !== operation.source_sha256
      || frozenDigest(operation.operation_id, operation.baseline, source, additions) !== operation.receipt.frozen_sha256) return refuse('The journal operation differs from its frozen digest');
    return operation;
  } catch (error) {
    if (error instanceof AdditionRefused) throw error;
    return refuse('The journal operation is malformed');
  }
}

function freezeOperation(input: { operationId: string; connection: string; sourcePath: string; original: string; baseline: Baseline; sourceRows: RawRows; maximumStatements: number }): Operation {
  const sourceRows = normalizedRows(input.sourceRows);
  let plan: ReturnType<typeof additiveMerge>;
  try { plan = additiveMerge({ source: sourceRows, destination: input.baseline.rows }); } catch (error) { return refuse(error instanceof Error ? error.message : 'Source cannot be added'); }
  const [schemaVersionGuard, ...rest] = plan.statements;
  if (!schemaVersionGuard) return refuse('Addition plan has no schema guard');
  const additions = [schemaVersionGuard, ...barrierGuards(input.baseline), ...rest];
  const sourceDigest = sha256(stableJson(sourceRows)) as SourceDigest;
  const frozen = frozenDigest(input.operationId, input.baseline, sourceDigest, additions);
  const receipt: Receipt = {
    singleton: 1, operation_id: input.operationId, frozen_sha256: frozen, destination_incarnation: input.baseline.incarnation,
    checkpoint_layout: input.baseline.layout, original_sha256: input.baseline.originalDigest, baseline_sha256: input.baseline.digest,
    expected_sha256: plan.digest, counts_json: JSON.stringify(plan.counts),
  };
  const statements = [...additions, ...packetEnd(receipt)];
  if (statements.length > input.maximumStatements) refuse(`The atomic addition needs ${statements.length} statements, above the limit of ${input.maximumStatements}`);
  return {
    format: 'polylinedb.restored-addition', version: 1, operation_id: input.operationId, connection: input.connection, source_path: input.sourcePath,
    original: input.original, baseline: input.baseline, source_rows: sourceRows, source_sha256: sourceDigest,
    receipt, statements, expected: canonicalSnapshot(plan.expectedSnapshot), counts: plan.counts,
  };
}

type Journal = { directory: string; has(name: string): boolean; read<T>(name: string): T; write(name: string, value: unknown): void; next(prefix: string): string };

function journal(directory: string, fresh: boolean): Journal {
  if (!isAbsolute(directory)) refuse('The journal directory must be absolute');
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid())) refuse('The journal must be a private directory');
  if (fresh && readdirSync(directory).length !== 0) refuse('Use an empty journal directory for a new addition');
  const path = (name: string) => join(directory, name);
  return {
    directory,
    has: name => existsSync(path(name)),
    read: name => JSON.parse(readFileSync(path(name), 'utf8')),
    write(name, value) {
      const descriptor = openSync(path(name), 'wx', 0o600);
      try { writeSync(descriptor, JSON.stringify(value)); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      const folder = openSync(directory, 'r');
      try { fsyncSync(folder); } finally { closeSync(folder); }
    },
    next(prefix) {
      let attempt = 1;
      while (existsSync(path(`${prefix}-${attempt}.json`))) attempt += 1;
      return `${prefix}-${attempt}.json`;
    },
  };
}

const canonicalSourceSchema = profileSchema([]);
function retiredSourceSchema(connection: string): string {
  const reference = new DatabaseSync(':memory:');
  try {
    reference.exec(SCHEMA_SQL);
    reference.exec('BEGIN');
    retireSource(reference, connection);
    reference.exec('COMMIT');
    return stableJson(reference.prepare(schemaSql).all());
  } finally { reference.close(); }
}

/** Reads the source rows. Only recovery passes `retiredFor`, because a crash can follow the retirement commit. */
function readSource(database: DatabaseSync, retiredFor?: string): RawRows {
  const schema = stableJson(database.prepare(schemaSql).all());
  if (schema !== canonicalSourceSchema && (retiredFor === undefined || schema !== retiredSourceSchema(retiredFor))) refuse('Source schema differs from canonical schema 6');
  return normalizedRows(Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row }))])));
}

function lockedSource(path: string): DatabaseSync {
  let stat: ReturnType<typeof lstatSync>;
  try { stat = lstatSync(path); } catch { return refuse('The source store is missing'); }
  if (!stat.isFile() || stat.isSymbolicLink()) refuse('The source store must be a regular file');
  const database = new DatabaseSync(path);
  database.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
  return database;
}

type Classification = { state: 'committed' } | { state: 'unchanged' };
function classify(destination: Capture, operation: Operation): Classification {
  if (destination.profile.kind === 'terminal') {
    if (destination.receipt.length !== 1) throw new AdditionUnknown('The terminal layout has no single addition receipt');
    if (stableJson(destination.receipt[0]) !== stableJson(operation.receipt)) return refuse('Destination recorded a different addition');
    if (destination.checkpoint.length !== 1 || stableJson(destination.checkpoint[0]) !== stableJson(operation.baseline.checkpoint) || destination.visibleCheckpoint.length !== 0) throw new AdditionUnknown('The addition receipt and the archived checkpoint disagree');
    return { state: 'committed' };
  }
  if (destination.profile.layout !== operation.baseline.layout) return refuse('Destination checkpoint layout changed after freezing');
  const digest = sha256(stableJson({ schema: destination.schema, version: destination.version, checkpoint: destination.checkpoint[0] && stable(destination.checkpoint[0]), rows: normalizedRows(destination.rows) }));
  if (destination.checkpoint.length !== 1 || digest !== operation.baseline.digest) return refuse('Destination changed after freezing, and no addition receipt exists');
  return { state: 'unchanged' };
}

async function matchingReceipt(batch: Batch, operation: Operation): Promise<boolean> {
  try {
    const [found] = await batch([{ sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", params: [receiptTable] }]);
    if (!found?.length) return false;
    const [receipts] = await batch([{ sql: `SELECT * FROM ${receiptTable}`, params: [] }]);
    return receipts?.length === 1 && stableJson(receipts[0]) === stableJson(operation.receipt);
  } catch { throw new AdditionUnknown('Destination evidence is unavailable'); }
}

/** A later schema change must not hide a matching receipt, so a refused capture still reads the receipt. */
async function committedState(batch: Batch, operation: Operation): Promise<Classification['state']> {
  let destination: Capture;
  try { destination = await capture(batch); } catch (error) {
    if (error instanceof AdditionRefused && await matchingReceipt(batch, operation)) return 'committed';
    throw error;
  }
  return classify(destination, operation).state;
}

async function commit(batch: Batch, book: Journal, operation: Operation): Promise<void> {
  if (book.has('committed.json')) return;
  if (await committedState(batch, operation) !== 'committed') {
    book.write(book.next('dispatch'), { frozen_sha256: operation.receipt.frozen_sha256 });
    try { await batch(operation.statements); } catch {
      throw new AdditionUnknown('The addition batch did not return a result; resume classifies the destination');
    }
    if (await committedState(batch, operation) !== 'committed') throw new AdditionUnknown('The addition batch returned, but the destination shows no receipt');
  }
  book.write('committed.json', { receipt: operation.receipt });
}

async function verify(batch: Batch, book: Journal, operation: Operation): Promise<void> {
  if (book.has('verified.json')) return;
  const destination = await capture(batch);
  classify(destination, operation);
  let result: string;
  try { result = canonicalSnapshot(rawToSnapshot(destination.rows)); } catch { return refuse('The addition committed, but the destination is no longer a canonical store'); }
  if (result !== operation.expected || destinationIncarnation(destination.rows) !== operation.receipt.destination_incarnation) refuse('The addition committed, but the destination changed afterward; source retirement waits');
  book.write('verified.json', { expected_sha256: operation.receipt.expected_sha256 });
}

function retire(book: Journal, operation: Operation, held?: DatabaseSync): void {
  if (book.has('retired.json')) return;
  const database = held ?? lockedSource(operation.source_path);
  try {
    if (stableJson(readSource(database, operation.connection)) !== stableJson(operation.source_rows)) refuse('The source changed after freezing; source retirement waits');
    retireSource(database, operation.connection);
    database.exec('COMMIT');
  } finally {
    if (database.isTransaction) database.exec('ROLLBACK');
    if (!held) database.close();
  }
  book.write('retired.json', { connection: operation.connection });
}

const outcome = (operation: Operation): AdditionOutcome => ({ outcome: 'retired', operation_id: operation.operation_id, expected_sha256: operation.receipt.expected_sha256, counts: operation.counts });

export function restoredAddition(destination: Batch, journalDirectory: string) {
  return {
    async run(input: { original: string; source: string; connection: string; maximumStatements?: number }): Promise<AdditionOutcome> {
      const maximumStatements = input.maximumStatements ?? maximumStatementLimit;
      if (!Number.isSafeInteger(maximumStatements) || maximumStatements < 1 || maximumStatements > maximumStatementLimit) refuse('The statement limit must be between 1 and 1000');
      if (!isAbsolute(input.original) || !isAbsolute(input.source)) refuse('The original input and source paths must be absolute');
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(input.connection)) refuse('Invalid cloud connection name');
      const book = journal(journalDirectory, true);
      let original: string;
      try { original = readFileSync(input.original, 'utf8'); } catch { return refuse('The original restore input is missing'); }
      const baseline = restoredBaseline(await capture(destination), original);
      const source = lockedSource(input.source);
      try {
        const sourceRows = readSource(source);
        const operation = freezeOperation({ operationId: randomUUID(), connection: input.connection, sourcePath: input.source, original, baseline, sourceRows, maximumStatements });
        book.write('operation.json', operation);
        await commit(destination, book, operation);
        await verify(destination, book, operation);
        retire(book, operation, source);
        return outcome(operation);
      } finally {
        if (source.isTransaction) source.exec('ROLLBACK');
        source.close();
      }
    },
    async resume(): Promise<AdditionOutcome> {
      const book = journal(journalDirectory, false);
      if (!book.has('operation.json')) refuse('The journal has no frozen addition');
      let stored: unknown;
      try { stored = book.read<unknown>('operation.json'); } catch { return refuse('The journal operation is malformed'); }
      const operation = frozenOperation(stored);
      await commit(destination, book, operation);
      await verify(destination, book, operation);
      retire(book, operation);
      return outcome(operation);
    },
  };
}
