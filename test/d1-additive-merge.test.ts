// Exercises additive merge guards and source retirement against synthetic SQLite stores.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { executeOperation, parseOperation } from "../src/records/index.ts";
import { executeMemoryOperation, parseMemoryOperation } from "../src/records/memories.ts";
import { canonicalSnapshot } from "../src/records/snapshot.ts";
import { initializeStore, openStore } from "../src/local-store/index.ts";
import { additiveMerge, rawToSnapshot, retireSource, tables } from '../scripts/d1-additive-merge.ts';

type StoreFile = { databasePath: string; close(): void };

function createStore(directory: string, name: string): StoreFile & { store: ReturnType<typeof openStore> } {
  const location = { directory: join(directory, name) };
  const { database_path: databasePath } = initializeStore(location);
  const store = openStore(location);
  return { databasePath, store, close: () => store.close() };
}

async function addIssue(store: ReturnType<typeof openStore>, input: { prefix: string; body: string; type?: 'task' | 'epic'; parent?: string }, actor: string) {
  const result = await executeOperation(store.db, parseOperation({
    op: 'create',
    prefix: input.prefix,
    request_id: randomUUID(),
    tool: 'merge-fixture',
    project: 'synthetic',
    body: input.body,
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.parent === undefined ? {} : { parent: input.parent }),
  }), actor);
  if (!('issue' in result)) throw new Error('Issue creation did not return an issue');
  return result.issue;
}

async function addComment(store: ReturnType<typeof openStore>, issueId: string, body: string, actor: string): Promise<void> {
  const result = await executeOperation(store.db, parseOperation({ op: 'comment', id: issueId, body }), actor);
  if (!('comment' in result)) throw new Error('Comment creation did not return a comment');
}

async function addMemory(store: ReturnType<typeof openStore>, prefix: string, actor: string) {
  const result = await executeMemoryOperation(store.db, parseMemoryOperation({
    op: 'memory_create', prefix, request_id: randomUUID(), project: 'synthetic', title: `${prefix} title`, body: `${prefix} body`,
  }), actor);
  if (!('memory' in result)) throw new Error('Memory creation did not return a memory');
  return result.memory;
}

async function makeSource(directory: string, prefix = 'src', includeLiveMemory = false): Promise<string> {
  const fixture = createStore(directory, `source-${prefix}`);
  try {
    const epic = await addIssue(fixture.store, { prefix, body: `${prefix} original`, type: 'epic' }, `${prefix}-author`);
    await executeOperation(fixture.store.db, parseOperation({ op: 'update', id: epic.id, changes: [{ field: 'body', value: `${prefix} revised`, expected: 1 }] }), `${prefix}-editor`);
    await addIssue(fixture.store, { prefix, parent: epic.id, body: `${prefix} child` }, `${prefix}-child-author`);
    await executeOperation(fixture.store.db, parseOperation({ op: 'dependency_add', dependent_id: `${epic.id}.1`, blocker_id: epic.id, expected_revision: 1, request_id: randomUUID() }), `${prefix}-author`);
    await addComment(fixture.store, epic.id, `${prefix} comment`, `${prefix}-commenter`);
    const claim = await executeOperation(fixture.store.db, parseOperation({ op: 'claim_show', issue_id: epic.id }), `${prefix}-author`);
    assert.ok('claim' in claim);
    await executeOperation(fixture.store.db, parseOperation({ op: 'claim_acquire', issue_id: epic.id, incarnation: claim.claim.store_incarnation, session_id: randomUUID(), request_id: randomUUID(), agent_label: 'Codex' }), `${prefix}-author`);
    const deletedMemory = await addMemory(fixture.store, prefix, `${prefix}-memory-author`);
    await executeMemoryOperation(fixture.store.db, parseMemoryOperation({ op: 'memory_delete', project: 'synthetic', id: deletedMemory.id, expected: 1 }), `${prefix}-memory-editor`);
    if (includeLiveMemory) await addMemory(fixture.store, `${prefix}live`, `${prefix}-live-memory-author`);
  } finally { fixture.close(); }
  return fixture.databasePath;
}

async function makeDestination(directory: string, prefix = 'dst', includeDeletedMemory = false, memoryPrefix = prefix): Promise<string> {
  const fixture = createStore(directory, `destination-${prefix}`);
  try {
    const issue = await addIssue(fixture.store, { prefix, body: `${prefix} original` }, `${prefix}-author`);
    await executeOperation(fixture.store.db, parseOperation({ op: 'close', id: issue.id, expected: 1 }), `${prefix}-closer`);
    const claim = await executeOperation(fixture.store.db, parseOperation({ op: 'claim_show', issue_id: issue.id }), `${prefix}-author`); assert.ok('claim' in claim);
    await executeOperation(fixture.store.db, parseOperation({ op: 'claim_acquire', issue_id: issue.id, incarnation: claim.claim.store_incarnation, session_id: randomUUID(), request_id: randomUUID(), agent_label: 'Cursor' }), `${prefix}-author`);
    await addComment(fixture.store, issue.id, `${prefix} comment`, `${prefix}-commenter`);
    const memory = await addMemory(fixture.store, memoryPrefix, `${prefix}-memory-author`);
    if (includeDeletedMemory) {
      await executeMemoryOperation(fixture.store.db, parseMemoryOperation({ op: 'memory_delete', project: 'synthetic', id: memory.id, expected: 1 }), `${prefix}-memory-editor`);
    } else {
      await executeMemoryOperation(fixture.store.db, parseMemoryOperation({ op: 'memory_update', project: 'synthetic', id: memory.id, title: `${prefix} revised`, body: `${prefix} revised body`, expected: 1 }), `${prefix}-memory-editor`);
    }
  } finally { fixture.close(); }
  return fixture.databasePath;
}

async function makeLargeStore(directory: string, name: string, prefix: string): Promise<string> {
  const fixture = createStore(directory, name);
  try {
    for (let index = 0; index < 8; index += 1) await addIssue(fixture.store, { prefix, body: 'x'.repeat(60_000) }, `${prefix}-author`);
  } finally { fixture.close(); }
  return fixture.databasePath;
}

function readRows(database: DatabaseSync): unknown {
  return Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT * FROM ${table}`).all()]));
}

function openDatabase(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON');
  return database;
}

function executePlan(database: DatabaseSync, statements: readonly { sql: string; params: (string | number | null)[] }[]): void {
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const statement of statements) database.prepare(statement.sql).all(...statement.params);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

test('additive merge keeps both canonical stores, versions, audit rows, and deletion receipts', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'pd-additive-merge-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = await makeSource(directory);
  const destinationPath = await makeDestination(directory);
  const sourceDatabase = openDatabase(sourcePath);
  const destinationDatabase = openDatabase(destinationPath);
  try {
    const source = readRows(sourceDatabase);
    const destination = readRows(destinationDatabase);
    const sourceSnapshot = rawToSnapshot(source);
    const destinationSnapshot = rawToSnapshot(destination);
    const plan = additiveMerge({ source, destination });
    assert.equal(plan.digest, createHash('sha256').update(canonicalSnapshot(plan.expectedSnapshot)).digest('hex'));
    assert.equal(plan.counts.added.issues, sourceSnapshot.issues.length);
    assert.equal(plan.counts.total.issues, sourceSnapshot.issues.length + destinationSnapshot.issues.length);
    assert.ok(plan.statements.length > 1);
    for (const statement of plan.statements) {
      assert.ok(Buffer.byteLength(statement.sql, 'utf8') < 100_000);
      assert.ok(statement.params.length <= 100);
      for (const parameter of statement.params) if (typeof parameter === 'string') assert.ok(Buffer.byteLength(parameter, 'utf8') <= 400_000);
    }

    executePlan(destinationDatabase, plan.statements);
    const actual = rawToSnapshot(readRows(destinationDatabase));
    assert.equal(canonicalSnapshot(actual), canonicalSnapshot(plan.expectedSnapshot));
    assert.equal(actual.issues.find(issue => issue.id === 'src-1')?.body, 'src revised');
    assert.equal(actual.issues.find(issue => issue.id === 'src-1')?.versions.body, 2);
    assert.equal(actual.issues.find(issue => issue.id === 'src-1')?.updated_by, 'src-editor');
    assert.equal(actual.issues.find(issue => issue.id === 'dst-1')?.status, 'closed');
    assert.equal(actual.issues.find(issue => issue.id === 'dst-1')?.updated_by, 'dst-closer');
    assert.deepEqual(actual.comments.map(comment => comment.body).sort(), ['dst comment', 'src comment']);
    assert.deepEqual(actual.memories.map(memory => memory.id), ['dst-m1']);
    assert.ok(actual.memory_requests.some(request => request.memory_id === 'src-m1'));
    assert.ok(actual.memory_requests.some(request => request.memory_id === 'dst-m1'));
  } finally {
    sourceDatabase.close();
    destinationDatabase.close();
  }
});

test('destination row changes fail the first guarded batch and retain all pre-batch rows', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'pd-additive-guard-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = await makeSource(directory);
  const destinationPath = await makeDestination(directory);
  const sourceDatabase = openDatabase(sourcePath);
  const destinationDatabase = openDatabase(destinationPath);
  try {
    const plan = additiveMerge({ source: readRows(sourceDatabase), destination: readRows(destinationDatabase) });
    destinationDatabase.prepare("UPDATE issues SET body = 'changed after planning' WHERE id = 'dst-1'").run();
    assert.throws(() => executePlan(destinationDatabase, plan.statements), /CHECK constraint failed/);
    const after = rawToSnapshot(readRows(destinationDatabase));
    assert.equal(after.issues.length, 1);
    assert.equal(after.issues[0]?.body, 'changed after planning');
    assert.ok(after.issues.every(issue => !issue.id.startsWith('src-')));
  } finally {
    sourceDatabase.close();
    destinationDatabase.close();
  }
});
test('same-incarnation merge refuses planning and destination metadata races roll back every source row', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'pd-additive-metadata-')); context.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = openDatabase(await makeSource(directory, 'source', true)); const destination = openDatabase(await makeDestination(directory, 'dest'));
  try {
    const originalIdentity = destination.prepare('SELECT incarnation FROM memory_store_identity').get()?.incarnation;
    const sourceIdentity = source.prepare('SELECT incarnation FROM memory_store_identity').get()?.incarnation; assert.equal(typeof sourceIdentity, 'string'); assert.equal(typeof originalIdentity, 'string');
    if (typeof sourceIdentity !== 'string' || typeof originalIdentity !== 'string') throw new Error('Invalid fixture identity');
    destination.prepare('UPDATE memory_store_identity SET incarnation=?').run(sourceIdentity);
    const same = readRows(destination); assert.throws(() => additiveMerge({ source: readRows(source), destination: same }), /incarnations must differ/); assert.deepEqual(readRows(destination), same);
    destination.prepare('UPDATE memory_store_identity SET incarnation=?').run(originalIdentity);
    for (const change of ["UPDATE memory_store_identity SET incarnation=lower(hex(randomblob(16)))", 'UPDATE project_memory_revisions SET revision=revision+1']) {
      const plan = additiveMerge({ source: readRows(source), destination: readRows(destination) });
      destination.exec(change); const changed = readRows(destination);
      assert.throws(() => executePlan(destination, plan.statements), /CHECK constraint failed/); assert.deepEqual(readRows(destination), changed);
    }
    const owner = destination.prepare("SELECT * FROM issue_claims WHERE issue_id='dest-1'").get(); assert.ok(owner);
    destination.prepare('UPDATE memory_store_identity SET incarnation=?').run(owner.incarnation);
    const plan = additiveMerge({ source: readRows(source), destination: readRows(destination) }); executePlan(destination, plan.statements);
    assert.deepEqual(destination.prepare("SELECT * FROM issue_claims WHERE issue_id='dest-1'").get(), owner);
    assert.equal(destination.prepare('SELECT incarnation FROM memory_store_identity').get()?.incarnation, owner.incarnation);
    assert.equal(destination.prepare("SELECT count(*) AS count FROM issue_claims AS claim JOIN memory_store_identity AS identity ON singleton=1 WHERE claim.issue_id='source-1' AND claim.incarnation<>identity.incarnation").get()?.count, 1);
  } finally { source.close(); destination.close(); }
});

test('raw rows reject derived keys that do not match their canonical IDs', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'pd-additive-canonical-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = await makeSource(directory);
  const database = openDatabase(sourcePath);
  try {
    database.prepare("UPDATE issues SET sort_key = 'wrong' WHERE id = 'src-1'").run();
    assert.throws(() => rawToSnapshot(readRows(database)), /rows are not a canonical snapshot/);
  } finally { database.close(); }
});

test('an insert failure after issue rows rolls the complete merge batch back', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'pd-additive-rollback-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = await makeSource(directory);
  const destination = createStore(directory, 'empty-destination');
  destination.close();
  const sourceDatabase = openDatabase(sourcePath);
  const destinationDatabase = openDatabase(destination.databasePath);
  try {
    const plan = additiveMerge({ source: readRows(sourceDatabase), destination: readRows(destinationDatabase) });
    destinationDatabase.exec("CREATE TRIGGER reject_merge_comment BEFORE INSERT ON comments BEGIN SELECT RAISE(ABORT, 'synthetic middle failure'); END");
    assert.throws(() => executePlan(destinationDatabase, plan.statements), /synthetic middle failure/);
    const after = rawToSnapshot(readRows(destinationDatabase));
    assert.equal(after.issues.length, 0);
    assert.equal(after.comments.length, 0);
    assert.equal(after.counters.length, 0);
  } finally {
    sourceDatabase.close();
    destinationDatabase.close();
  }
});

test('large destination guards and source inserts split below the D1 JSON limit', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'pd-additive-chunks-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = await makeLargeStore(directory, 'large-source', 'bigsrc');
  const destinationPath = await makeLargeStore(directory, 'large-destination', 'bigdst');
  const sourceDatabase = openDatabase(sourcePath);
  const destinationDatabase = openDatabase(destinationPath);
  try {
    const plan = additiveMerge({ source: readRows(sourceDatabase), destination: readRows(destinationDatabase) });
    const issueGuards = plan.statements.filter(statement => statement.sql.includes('WITH captured AS') && statement.sql.includes('FROM "issues"'));
    const issueInserts = plan.statements.filter(statement => statement.sql.startsWith('INSERT INTO "issues"'));
    assert.equal(issueGuards.length, 2);
    assert.equal(issueInserts.length, 2);
    assert.ok(plan.statements.every(statement => statement.params.every(parameter => typeof parameter !== 'string' || Buffer.byteLength(parameter, 'utf8') <= 400_000)));
    executePlan(destinationDatabase, plan.statements);
    assert.equal(rawToSnapshot(readRows(destinationDatabase)).issues.length, 16);
  } finally {
    sourceDatabase.close();
    destinationDatabase.close();
  }
});

test('a deletion receipt prevents a matching memory ID from returning during merge', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'pd-additive-memory-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = await makeDestination(directory, 'src', false, 'same');
  const destinationPath = await makeDestination(directory, 'dst', true, 'same');
  const sourceDatabase = openDatabase(sourcePath);
  const destinationDatabase = openDatabase(destinationPath);
  try {
    assert.throws(() => additiveMerge({ source: readRows(sourceDatabase), destination: readRows(destinationDatabase) }), /deletion receipt would be undone/);
  } finally {
    sourceDatabase.close();
    destinationDatabase.close();
  }
});

test('retirement blocks every DML operation on an already open SQLite connection', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'pd-additive-retire-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const sourcePath = await makeSource(directory, 'retire', true);
  const database = openDatabase(sourcePath);
  try {
    const preparedBeforeRetirement = database.prepare('INSERT INTO counters SELECT * FROM counters LIMIT 1');
    assert.throws(() => retireSource(database, "retired'; DROP TABLE issues; --"), /Invalid cloud connection name/);
    database.exec('BEGIN IMMEDIATE');
    retireSource(database, 'archive');
    database.exec('COMMIT');
    assert.equal(database.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type='trigger' AND name GLOB 'polylinedb_retired_*'").get()?.count, tables.length * 3);
    database.exec('BEGIN IMMEDIATE');
    retireSource(database, 'archive');
    database.exec('COMMIT');
    assert.throws(() => preparedBeforeRetirement.all(), /Use cloud connection archive/);
    for (const table of tables) {
      const key = table === 'issues' || table === 'comments' || table === 'memories' ? 'id'
        : table === 'counters' ? 'scope'
          : table === 'memory_counters' ? 'prefix' : table === 'dependencies' || table === 'dependency_revisions' ? 'dependent_id' : table === 'issue_claims' ? 'issue_id' : table === 'memory_store_identity' ? 'singleton' : table === 'project_memory_revisions' ? 'project' : 'request_id';
      const quotedTable = `"${table}"`;
      const quotedKey = `"${key}"`;
      assert.throws(() => database.prepare(`INSERT INTO ${quotedTable} SELECT * FROM ${quotedTable} LIMIT 1`).all(), /Use cloud connection archive/, `${table} insert`);
      assert.throws(() => database.prepare(`UPDATE ${quotedTable} SET ${quotedKey} = ${quotedKey}`).all(), /Use cloud connection archive/, `${table} update`);
      assert.throws(() => database.prepare(`DELETE FROM ${quotedTable}`).all(), /Use cloud connection archive/, `${table} delete`);
    }
    const tableCount = database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get();
    assert.equal(tableCount?.count, tables.length + 1);
    for (const table of ['memory_store_identity', 'project_memory_revisions']) {
      assert.throws(() => database.exec(`INSERT INTO ${table} SELECT * FROM ${table} LIMIT 1`), /Use cloud connection archive/);
      assert.throws(() => database.exec(`DELETE FROM ${table}`), /Use cloud connection archive/);
    }
    assert.throws(() => database.exec('UPDATE memory_store_identity SET incarnation = lower(hex(randomblob(16)))'), /Use cloud connection archive/);
    assert.throws(() => database.exec('UPDATE project_memory_revisions SET revision = revision + 1'), /Use cloud connection archive/);
  } finally { database.close(); }
});
