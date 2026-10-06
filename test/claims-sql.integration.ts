// Checks the same atomic lease statements on SQLite and local workerd D1; production accounts stay outside.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_STATEMENTS } from '../src/records/schema.ts';
import { CLAIM_STATEMENTS, claimMutationStatements, claimProofPredicate, issueClaimGuard } from '../src/records/claims-sql.ts';
import type { ClaimMutation, ClaimProof } from '../src/records/claims-sql.ts';
import type { SqlStatement } from '../src/records/issues.ts';

type Row = Record<string, unknown>;
type Backend = { batch(statements: readonly SqlStatement[]): Promise<readonly Row[][]>; dispose(): Promise<void> };
const directory = mkdtempSync(join(tmpdir(), 'pd-claims-proof-'));
const path = join(directory, 'proof.sqlite');
function sqliteBatch(database: DatabaseSync, statements: readonly SqlStatement[]): Row[][] {
  database.exec('BEGIN IMMEDIATE');
  try {
    const rows = statements.map(({ sql, params }) => database.prepare(sql).all(...params).map(row => ({ ...row })));
    database.exec('COMMIT'); return rows;
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}
const local = new DatabaseSync(path); local.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000');
const sqlite: Backend = { async batch(statements) { return sqliteBatch(local, statements); }, async dispose() { local.close(); } };
const { Miniflare } = await import('miniflare');
const runtime = new Miniflare({ workers: [{ config: { name: 'claims-proof', compatibilityDate: '2026-09-25', manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response("ready"); } }' } } }, env: { DB: { type: 'd1', name: 'claims-proof' } } } }] });
const database = await runtime.getD1Database('DB');
const d1: Backend = { async batch(statements) { return (await database.batch(statements.map(({ sql, params }) => database.prepare(sql).bind(...params)))).map((result: { results: Row[] }) => result.results); }, async dispose() { await runtime.dispose(); } };
const sql = (text: string, params: SqlStatement['params'] = []): SqlStatement => ({ sql: text, params });
const actor = 'test:owner';
const session = () => crypto.randomUUID();
const acquire = (issue_id: string, session_id = session()): ClaimMutation => ({ op: 'claim_acquire', issue_id, session_id, request_id: crypto.randomUUID(), ttl: 300, agent_label: 'Codex' });
function proof(row: Row): ClaimProof {
  assert.equal(typeof row.issue_id, 'string'); assert.equal(typeof row.incarnation, 'string'); assert.equal(typeof row.session_id, 'string'); assert.equal(typeof row.generation, 'number');
  if (typeof row.issue_id !== 'string' || typeof row.incarnation !== 'string' || typeof row.session_id !== 'string' || typeof row.generation !== 'number') throw new Error('Invalid receipt');
  return { issue_id: row.issue_id, incarnation: row.incarnation, session_id: row.session_id, generation: row.generation };
}
async function run(db: Backend, command: ClaimMutation, identity = actor): Promise<Row> {
  try {
    const rows = await db.batch(claimMutationStatements(command, identity));
    const receipt = rows.at(-1)?.[0]; if (!receipt) throw new Error('claim_rejected'); return receipt;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('UNIQUE constraint failed: claim_requests.request_id')) throw error;
    const row = (await db.batch([sql('SELECT * FROM claim_requests WHERE request_id = ?', [command.request_id])]))[0]?.[0];
    assert.ok(row);
    if (row.actor !== identity || row.payload !== JSON.stringify(command)) throw new Error('claim_request_conflict');
    return row;
  }
}
async function read(db: Backend, query: string, params: SqlStatement['params'] = []) { return (await db.batch([sql(query, params)]))[0] ?? []; }
async function raceSqlite(commands: readonly ClaimMutation[]) {
  const results = await Promise.all(commands.map(command => new Promise<boolean>((resolve, reject) => {
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads'); const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(workerData.path); db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON'); try { db.exec('BEGIN IMMEDIATE'); let result; for (const s of workerData.statements) result=db.prepare(s.sql).all(...s.params); db.exec('COMMIT'); parentPort.postMessage(result.length===1); } catch(e) { db.exec('ROLLBACK'); parentPort.postMessage(false); } finally {db.close();}`, { eval: true, workerData: { path, statements: claimMutationStatements(command, actor) } });
    worker.once('message', resolve); worker.once('error', reject);
  })));
  return results;
}
try {
  for (const [name, db] of [['SQLite', sqlite], ['D1', d1]] as const) {
    await db.batch([...SCHEMA_STATEMENTS, ...CLAIM_STATEMENTS].map(statement => sql(statement)));
    for (let index = 1; index <= 10; index++) await db.batch([sql(`INSERT INTO issues(id,sort_key,parent_id,tool,project,body,status,type,priority,labels_json,created_at,created_by,updated_at,updated_by) VALUES (?, ?,NULL,'test','test','Issue','open','task',2,'[]','test','test','test','test')`, [`pd-${index}`, `test-${index}`])]);
    const competitors = [acquire('pd-1'), acquire('pd-1')];
    if (name === 'SQLite') assert.equal((await raceSqlite(competitors)).filter(Boolean).length, 1);
    else assert.equal((await Promise.allSettled(competitors.map(command => run(db, command)))).filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((await read(db, "SELECT * FROM claim_requests WHERE issue_id='pd-1'")).length, 1);
    const repeated = acquire('pd-2');
    if (name === 'SQLite') assert.equal((await raceSqlite([repeated, repeated])).filter(Boolean).length, 1);
    else { const race = await Promise.all([run(db, repeated), run(db, repeated)]); assert.deepEqual(race[0], race[1]); }
    const first = await run(db, repeated); assert.equal(first.generation, 1); assert.equal(first.revision, 1);
    const firstProof = proof(first);
    const renew: ClaimMutation = { op: 'claim_renew', claim_proof: firstProof, expected_revision: 1, request_id: crypto.randomUUID(), ttl: 300 };
    const renewed = await run(db, renew); assert.equal(renewed.revision, 2); assert.deepEqual(await run(db, repeated), first);
    await assert.rejects(run(db, { ...renew, request_id: crypto.randomUUID() }), /claim_rejected/);
    const release: ClaimMutation = { op: 'claim_release', claim_proof: firstProof, expected_revision: 2, request_id: crypto.randomUUID() };
    const released = await run(db, release); assert.equal(released.revision, 3);
    assert.deepEqual(await run(db, repeated), first); assert.deepEqual(await run(db, renew), renewed);
    const reacquired = await run(db, acquire('pd-2')); assert.equal(reacquired.generation, 2); assert.equal(reacquired.revision, 4);
    assert.deepEqual(await run(db, release), released);
    await assert.rejects(run(db, repeated, 'other'), /claim_request_conflict/);
    if (repeated.op !== 'claim_acquire') throw new Error('Invalid command');
    await assert.rejects(run(db, { ...repeated, session_id: session() }), /claim_request_conflict/);
    await assert.rejects(run(db, { ...repeated, issue_id: 'pd-999', ttl: 3600 }), /claim_request_conflict/);
    await db.batch([sql("UPDATE issue_claims SET expires_at=unixepoch() WHERE issue_id='pd-2'")]);
    const staleProof = proof(reacquired);
    const expired: ClaimMutation = { op: 'claim_release', claim_proof: staleProof, expected_revision: 4, request_id: crypto.randomUUID() };
    await assert.rejects(run(db, expired), /claim_rejected/);
    assert.deepEqual(await run(db, repeated), first);
    const afterExpiry = await run(db, acquire('pd-2')); assert.equal(afterExpiry.generation, 3); assert.equal(afterExpiry.revision, 5);
    await db.batch([sql("UPDATE memory_store_identity SET incarnation=lower(hex(randomblob(16)))")]);
    assert.deepEqual(await run(db, repeated), first);
    await assert.rejects(run(db, { op: 'claim_renew', claim_proof: proof(afterExpiry), expected_revision: 5, request_id: crypto.randomUUID(), ttl: 300 }), /claim_rejected/);
    const afterRotation = await run(db, acquire('pd-2')); assert.equal(afterRotation.generation, 4); assert.equal(afterRotation.revision, 6);
    const missing = acquire('pd-3'); const missingRow = await run(db, missing);
    await db.batch([sql("DELETE FROM claim_requests WHERE issue_id='pd-3'"), sql("DELETE FROM issue_claims WHERE issue_id='pd-3'"), sql("UPDATE memory_store_identity SET incarnation=lower(hex(randomblob(16)))")]);
    const oldProof = claimProofPredicate(proof(missingRow), actor);
    for (const field of ['status', 'body']) {
      const changed = await read(db, `UPDATE issues SET ${field}=? WHERE id='pd-3' AND ${oldProof.sql} RETURNING id`, [field === 'status' ? 'closed' : 'changed', ...oldProof.params]); assert.deepEqual(changed, []);
    }
    const oldScopeRequest = { ...missing, incarnation: missingRow.incarnation };
    await assert.rejects(run(db, oldScopeRequest), /claim_rejected/);
    assert.deepEqual(await read(db, "SELECT * FROM issue_claims WHERE issue_id='pd-3'"), []);
    assert.deepEqual(await read(db, "SELECT * FROM claim_requests WHERE issue_id='pd-3'"), []);
    const currentIdentity = (await read(db, 'SELECT incarnation FROM memory_store_identity WHERE singleton=1'))[0];
    assert.ok(currentIdentity);
    const newScopeRequest = { ...acquire('pd-3'), incarnation: currentIdentity.incarnation };
    const fresh = await run(db, newScopeRequest); assert.equal(fresh.generation, 1); assert.notEqual(fresh.incarnation, missingRow.incarnation);
    const protectedUpdate = async (issue: string, owner: ClaimProof | undefined, status: boolean, expected = 1) => {
      const guard = issueClaimGuard(issue, owner, status, actor);
      return read(db, `UPDATE issues SET body='changed',body_v=body_v+1${status ? ",status='closed',status_v=status_v+1" : ''} WHERE id=? AND body_v=?${status ? ' AND status_v=1' : ''} AND ${guard.sql} RETURNING body,status,body_v,status_v`, [issue, expected, ...guard.params]);
    };
    assert.deepEqual(await protectedUpdate('pd-6', firstProof, true), []);
    assert.deepEqual(await protectedUpdate('pd-6', firstProof, false), []);
    assert.deepEqual(await protectedUpdate('pd-3', proof(missingRow), true), []);
    assert.deepEqual(await protectedUpdate('pd-3', undefined, true), []);
    assert.deepEqual(await protectedUpdate('pd-3', proof(fresh), true, 99), []);
    assert.deepEqual(await protectedUpdate('pd-3', proof(fresh), true), [{ body: 'changed', status: 'closed', body_v: 2, status_v: 2 }]);
    assert.deepEqual(await protectedUpdate('pd-6', undefined, true), [{ body: 'changed', status: 'closed', body_v: 2, status_v: 2 }]);
    assert.deepEqual(await protectedUpdate('pd-2', undefined, false), [{ body: 'changed', status: 'open', body_v: 2, status_v: 1 }]);
    const injected = acquire('pd-4'); const statements = [...claimMutationStatements(injected, actor)];
    statements[2] = sql('SELECT 1');
    await assert.rejects(db.batch(statements), /CHECK constraint failed/);
    assert.deepEqual(await read(db, "SELECT * FROM claim_requests WHERE issue_id='pd-4'"), []);
    assert.deepEqual(await read(db, "SELECT * FROM issue_claims WHERE issue_id='pd-4'"), []);
    const maxRequest = acquire('pd-5'); const beforeMax = await run(db, maxRequest);
    await db.batch([sql("UPDATE issue_claims SET revision=9007199254740991 WHERE issue_id='pd-5'")]);
    await assert.rejects(run(db, { op: 'claim_release', claim_proof: proof(beforeMax), expected_revision: Number.MAX_SAFE_INTEGER, request_id: crypto.randomUUID() }), /claim_rejected/);
    await db.batch([sql("UPDATE issue_claims SET generation=9007199254740991,revision=9007199254740991,released_at=unixepoch() WHERE issue_id='pd-5'")]);
    await assert.rejects(run(db, acquire('pd-5')), /claim_rejected/); assert.deepEqual(await run(db, maxRequest), beforeMax);
    assert.equal((await read(db, "SELECT * FROM claim_requests WHERE issue_id='pd-5'")).length, 1);
    process.stdout.write(`PASS ${name}: concurrent acquisition and UUID admission, original receipt history, actor/session/payload conflicts, CAS, equality expiry, rotation, missing history, rollback sentinel, MAX counters, old proof with no claim row\n`);
  }
} finally { await sqlite.dispose(); await d1.dispose(); rmSync(directory, { recursive: true, force: true }); }
