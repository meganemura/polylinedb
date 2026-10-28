// Checks the same atomic lease statements on SQLite and local workerd D1; production accounts stay outside.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_STATEMENTS } from '../src/records/persistence/schema.ts';
import { CLAIM_STATEMENTS, claimMutationStatements, claimProofPredicate, issueClaimGuard } from '../src/records/claims/claims-sql.ts';
import type { ClaimMutation, ClaimProof } from '../src/records/claims/claims-sql.ts';
import type { SqlStatement } from '../src/records/store/sql.ts';
import type { SqlExecutor } from '../src/records/store/sql.ts';
import { node } from 'solarsql/node';
import { d1Executor } from '../src/service/d1.ts';
import { executeOperation, parseOperation, PolylinedbError } from '../src/records/index.ts';

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
async function observeIncarnation(db: Backend): Promise<string> {
  const row = (await read(db, 'SELECT incarnation FROM memory_store_identity WHERE singleton=1'))[0];
  if (!row || typeof row.incarnation !== 'string' || !/^[a-f0-9]{32}$/.test(row.incarnation)) throw new Error('Invalid incarnation');
  return row.incarnation;
}
async function raceSqlite(commands: readonly ClaimMutation[]) {
  const results = await Promise.all(commands.map(command => new Promise<boolean>((resolve, reject) => {
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads'); const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(workerData.path); db.exec('PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON'); try { db.exec('BEGIN IMMEDIATE'); let result; for (const s of workerData.statements) result=db.prepare(s.sql).all(...s.params); db.exec('COMMIT'); parentPort.postMessage(result.length===1); } catch(e) { db.exec('ROLLBACK'); parentPort.postMessage(false); } finally {db.close();}`, { eval: true, workerData: { path, statements: claimMutationStatements(command, actor) } });
    worker.once('message', resolve); worker.once('error', reject);
  })));
  return results;
}
try {
  for (const [name, db] of [['SQLite', sqlite], ['D1', d1]] as const) {
    await db.batch(SCHEMA_STATEMENTS.map(statement => sql(statement)));
    let observedIncarnation = await observeIncarnation(db);
    const acquire = (issue_id: string, session_id = session()): ClaimMutation => ({ op: 'claim_acquire', issue_id, incarnation: observedIncarnation, session_id, request_id: crypto.randomUUID(), ttl: 300, agent_label: 'Codex' });
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
    await db.batch([sql("UPDATE issue_claims SET acquired_at=MIN(acquired_at,unixepoch()-1),expires_at=unixepoch() WHERE issue_id='pd-2'")]);
    const staleProof = proof(reacquired);
    const expired: ClaimMutation = { op: 'claim_release', claim_proof: staleProof, expected_revision: 4, request_id: crypto.randomUUID() };
    await assert.rejects(run(db, expired), /claim_rejected/);
    assert.deepEqual(await run(db, repeated), first);
    const afterExpiry = await run(db, acquire('pd-2')); assert.equal(afterExpiry.generation, 3); assert.equal(afterExpiry.revision, 5);
    await db.batch([sql("UPDATE memory_store_identity SET incarnation=lower(hex(randomblob(16)))")]);
    assert.deepEqual(await run(db, repeated), first);
    await assert.rejects(run(db, { op: 'claim_renew', claim_proof: proof(afterExpiry), expected_revision: 5, request_id: crypto.randomUUID(), ttl: 300 }), /claim_rejected/);
    const beforeOldScope = await read(db, "SELECT * FROM issue_claims WHERE issue_id='pd-2'");
    const receiptsBeforeOldScope = await read(db, "SELECT * FROM claim_requests WHERE issue_id='pd-2' ORDER BY revision");
    await assert.rejects(run(db, acquire('pd-2')), /claim_rejected/);
    assert.deepEqual(await read(db, "SELECT * FROM issue_claims WHERE issue_id='pd-2'"), beforeOldScope);
    assert.deepEqual(await read(db, "SELECT * FROM claim_requests WHERE issue_id='pd-2' ORDER BY revision"), receiptsBeforeOldScope);
    observedIncarnation = await observeIncarnation(db);
    const afterRotation = await run(db, acquire('pd-2')); assert.equal(afterRotation.generation, 4); assert.equal(afterRotation.revision, 6);
    const missing = acquire('pd-3'); const missingRow = await run(db, missing);
    await assert.rejects(db.batch([sql("UPDATE claim_requests SET actor='other' WHERE issue_id='pd-3'")]), /claim_receipt_immutable/);
    await assert.rejects(db.batch([sql("DELETE FROM claim_requests WHERE issue_id='pd-3'")]), /claim_receipt_immutable/);
    await db.batch([sql('DROP TRIGGER claim_requests_immutable_delete'), sql("DELETE FROM claim_requests WHERE issue_id='pd-3'"), sql("DELETE FROM issue_claims WHERE issue_id='pd-3'"), sql("UPDATE memory_store_identity SET incarnation=lower(hex(randomblob(16)))"), ...CLAIM_STATEMENTS.filter(statement => statement.startsWith('CREATE TRIGGER claim_requests_immutable_delete')).map(statement => sql(statement))]);
    const oldProof = claimProofPredicate(proof(missingRow), actor);
    for (const field of ['status', 'body']) {
      const changed = await read(db, `UPDATE issues SET ${field}=? WHERE id='pd-3' AND ${oldProof.sql} RETURNING id`, [field === 'status' ? 'closed' : 'changed', ...oldProof.params]); assert.deepEqual(changed, []);
    }
    await assert.rejects(run(db, missing), /claim_rejected/);
    assert.deepEqual(await read(db, "SELECT * FROM issue_claims WHERE issue_id='pd-3'"), []);
    assert.deepEqual(await read(db, "SELECT * FROM claim_requests WHERE issue_id='pd-3'"), []);
    observedIncarnation = await observeIncarnation(db);
    const newScopeRequest = acquire('pd-3');
    assert.notEqual(newScopeRequest.request_id, missing.request_id);
    const fresh = await run(db, newScopeRequest); assert.equal(fresh.generation, 1); assert.notEqual(fresh.incarnation, missingRow.incarnation);
    if (newScopeRequest.op !== 'claim_acquire') throw new Error('Invalid acquire');
    assert.deepEqual(await read(db, "SELECT issue_id,incarnation,actor,session_id,agent_label,generation,revision,released_at FROM issue_claims WHERE issue_id='pd-3'"), [
      { issue_id: 'pd-3', incarnation: observedIncarnation, actor, session_id: newScopeRequest.session_id, agent_label: 'Codex', generation: 1, revision: 1, released_at: null },
    ]);
    assert.equal((await read(db, "SELECT * FROM claim_requests WHERE issue_id='pd-3'"))[0]?.request_id, newScopeRequest.request_id);
    const protectedUpdate = async (issue: string, owner: ClaimProof | undefined, status: boolean, expected = 1) => {
      const guard = issueClaimGuard(issue, owner, { status: status ? 'closed' : null, type: null }, actor);
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
    await db.batch([sql("UPDATE issue_claims SET generation=9007199254740991,revision=9007199254740991,released_at=changed_at WHERE issue_id='pd-5'")]);
    await assert.rejects(run(db, acquire('pd-5')), /claim_rejected/); assert.deepEqual(await run(db, maxRequest), beforeMax);
    assert.equal((await read(db, "SELECT * FROM claim_requests WHERE issue_id='pd-5'")).length, 1);
    const executor: SqlExecutor = name === 'D1' ? d1Executor(database) : { reads: node(local), async batch(statements) { return (await db.batch(statements)).map(rows => ({ rows })); } };
    const product = (value: unknown, identity = actor) => executeOperation(executor, parseOperation(value), identity);
    const inspection = await product({ op: 'claim_show', issue_id: 'pd-7' }); assert.ok('claim' in inspection); assert.equal(inspection.claim.state, 'never_claimed');
    const acquireCommand = { op: 'claim_acquire', issue_id: 'pd-7', incarnation: inspection.claim.store_incarnation, session_id: session(), request_id: crypto.randomUUID(), agent_label: 'Codex' };
    const acquired = await product(acquireCommand); assert.ok('claim_receipt' in acquired);
    assert.deepEqual('open_blockers' in acquired ? acquired.open_blockers : undefined, []);
    await product({ op: 'dependency_add', dependent_id: 'pd-9', blocker_id: 'pd-10', expected_revision: 1, request_id: crypto.randomUUID() });
    await product({ op: 'dependency_add', dependent_id: 'pd-9', blocker_id: 'pd-6', expected_revision: 2, request_id: crypto.randomUUID() });
    const blockedShow = await product({ op: 'claim_show', issue_id: 'pd-9' }); assert.ok('claim' in blockedShow);
    const blockedCommand = { op: 'claim_acquire', issue_id: 'pd-9', incarnation: blockedShow.claim.store_incarnation, session_id: session(), request_id: crypto.randomUUID(), agent_label: 'Codex' };
    const blocked = await product(blockedCommand); assert.ok('claim_receipt' in blocked);
    assert.equal(blocked.claim_receipt.outcome, 'acquired');
    assert.equal(blocked.claim_receipt.generation, 1);
    assert.deepEqual('open_blockers' in blocked ? blocked.open_blockers : undefined, ['pd-10']);
    await product({ op: 'close', id: 'pd-10', expected: 1 });
    const blockedReplay = await product(blockedCommand); assert.ok('claim_receipt' in blockedReplay);
    assert.deepEqual(blockedReplay.claim_receipt, blocked.claim_receipt);
    assert.deepEqual('open_blockers' in blockedReplay ? blockedReplay.open_blockers : undefined, []);
    const productProof = proof(acquired.claim_receipt);
    await assert.rejects(product({ op: 'close', id: 'pd-7', expected: 1, force: true, reason: 'Exception' }), { code: 'claim_required' });
    await product({ op: 'close', id: 'pd-7', expected: 1, claim_proof: productProof });
    await product({ op: 'claim_renew', claim_proof: productProof, expected_revision: 1, request_id: crypto.randomUUID(), ttl: 3600 });
    assert.deepEqual(await product(acquireCommand), acquired);
    await assert.rejects(product(acquireCommand, 'other'), { code: 'claim_request_conflict' });
    await product({ op: 'claim_release', claim_proof: productProof, expected_revision: 2, request_id: crypto.randomUUID() });
    await assert.rejects(product({ op: 'reopen', id: 'pd-7', expected: 2, claim_proof: productProof }), { code: 'claim_required' });
    const closedOwner = await product({ ...acquireCommand, request_id: crypto.randomUUID(), session_id: session() }); assert.ok('claim_receipt' in closedOwner);
    await product({ op: 'reopen', id: 'pd-7', expected: 2, claim_proof: proof(closedOwner.claim_receipt) });
    const finalIssue = await product({ op: 'show', id: 'pd-7' }); assert.ok('issue' in finalIssue); assert.equal(finalIssue.issue.status, 'open'); assert.equal(finalIssue.issue.versions.status, 3);
    const expiredIssue = await product({ op: 'claim_show', issue_id: 'pd-8' }); assert.ok('claim' in expiredIssue);
    const expiredAcquire = { op: 'claim_acquire', issue_id: 'pd-8', incarnation: expiredIssue.claim.store_incarnation, session_id: session(), request_id: crypto.randomUUID(), agent_label: 'Codex' };
    const expiredOwner = await product(expiredAcquire); assert.ok('claim_receipt' in expiredOwner);
    const expiredProof = proof(expiredOwner.claim_receipt);
    const revisionBefore = expiredOwner.claim_receipt.revision;
    await db.batch([sql("UPDATE issue_claims SET acquired_at=MIN(acquired_at,unixepoch()-1),expires_at=unixepoch() WHERE issue_id='pd-8'")]);
    await assert.rejects(product({ op: 'claim_release', claim_proof: expiredProof, expected_revision: revisionBefore, request_id: crypto.randomUUID() }),
      (error: unknown) => error instanceof PolylinedbError && error.code === 'claim_conflict' && error.status === 409 && JSON.stringify(error.details).includes('"state":"expired"'));
    await assert.rejects(product({ op: 'claim_release', claim_proof: { ...expiredProof, session_id: session() }, expected_revision: revisionBefore, request_id: crypto.randomUUID(), expired_noop: true }), { code: 'claim_conflict' });
    await assert.rejects(product({ op: 'claim_release', claim_proof: { ...expiredProof, generation: expiredProof.generation + 1 }, expected_revision: revisionBefore, request_id: crypto.randomUUID(), expired_noop: true }), { code: 'claim_conflict' });
    const asBody = (value: unknown) => JSON.parse(JSON.stringify(value)) as { released?: boolean; current?: { state?: string; lease?: { revision?: number; released_at?: number | null } | null } };
    const noop = asBody(await product({ op: 'claim_release', claim_proof: expiredProof, expected_revision: revisionBefore, request_id: crypto.randomUUID(), expired_noop: true }));
    assert.equal(noop.released, false);
    assert.equal(noop.current?.state, 'expired');
    assert.equal(noop.current?.lease?.revision, revisionBefore);
    assert.equal(noop.current?.lease?.released_at, null);
    const shownExpired = await product({ op: 'claim_show', issue_id: 'pd-8' }); assert.ok('claim' in shownExpired);
    assert.equal(shownExpired.claim.state, 'expired');
    assert.equal(shownExpired.claim.lease?.revision, revisionBefore);
    const foreign = await product({ ...expiredAcquire, session_id: session(), request_id: crypto.randomUUID() }); assert.ok('claim_receipt' in foreign);
    await assert.rejects(product({ op: 'claim_release', claim_proof: expiredProof, expected_revision: foreign.claim_receipt.revision, request_id: crypto.randomUUID(), expired_noop: true }), { code: 'claim_conflict' });
    const activeForeign = await product({ op: 'claim_show', issue_id: 'pd-8' }); assert.ok('claim' in activeForeign);
    assert.equal(activeForeign.claim.state, 'active');
    assert.equal(activeForeign.claim.lease?.revision, foreign.claim_receipt.revision);
    await db.batch([sql("UPDATE issue_claims SET acquired_at=MIN(acquired_at,unixepoch()-1),expires_at=unixepoch() WHERE issue_id='pd-8'")]);
    await assert.rejects(product({ op: 'claim_release', claim_proof: expiredProof, expected_revision: foreign.claim_receipt.revision, request_id: crypto.randomUUID(), expired_noop: true }), { code: 'claim_conflict' });
    const stillForeign = await product({ op: 'claim_show', issue_id: 'pd-8' }); assert.ok('claim' in stillForeign);
    assert.equal(stillForeign.claim.state, 'expired');
    assert.equal(stillForeign.claim.lease?.revision, foreign.claim_receipt.revision);
    const cleanup = asBody(await product({ op: 'claim_release', claim_proof: proof(foreign.claim_receipt), expected_revision: 1, request_id: crypto.randomUUID(), expired_noop: true }));
    assert.equal(cleanup.released, false);
    assert.equal(cleanup.current?.lease?.revision, foreign.claim_receipt.revision);
    await db.batch([sql("INSERT INTO counters(scope,last_number) VALUES ('pd',10) ON CONFLICT(scope) DO UPDATE SET last_number = MAX(last_number, 10)")]);
    const handoffTarget = async (body: string) => {
      const created = await product({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'handoff', body, labels: ['ready', 'ui'] }); assert.ok('issue' in created);
      const shown = await product({ op: 'claim_show', issue_id: created.issue.id }); assert.ok('claim' in shown);
      const held = await product({ op: 'claim_acquire', issue_id: created.issue.id, incarnation: shown.claim.store_incarnation, session_id: session(), request_id: crypto.randomUUID() }); assert.ok('claim_receipt' in held);
      return { id: created.issue.id, receipt: held.claim_receipt };
    };
    const handedTarget = await handoffTarget('Handoff');
    const handoffCommand = { op: 'claim_handoff', claim_proof: proof(handedTarget.receipt), expected_revision: handedTarget.receipt.revision, request_id: crypto.randomUUID(), tip: 'abcdef0', summary: 'Enqueued.' };
    const handed = await product(handoffCommand); assert.ok('handoff' in handed);
    assert.deepEqual({ status: handed.handoff.issue.status, labels: handed.handoff.issue.labels, outcome: handed.claim_receipt.outcome }, { status: 'open', labels: ['main-wait', 'ui'], outcome: 'released' });
    assert.deepEqual(handed.handoff.comments.map(comment => comment.body), ['tip: abcdef0', 'Enqueued.']);
    assert.deepEqual(await product(handoffCommand), handed);
    await assert.rejects(product({ ...handoffCommand, summary: 'Other' }), { code: 'claim_request_conflict' });
    const failedTarget = await handoffTarget('Handoff rollback');
    const snapshot = async () => [await read(db, 'SELECT * FROM issues WHERE id = ?', [failedTarget.id]), await read(db, 'SELECT * FROM comments WHERE issue_id = ?', [failedTarget.id]),
      await read(db, 'SELECT * FROM issue_claims WHERE issue_id = ?', [failedTarget.id]), await read(db, 'SELECT * FROM claim_requests WHERE issue_id = ?', [failedTarget.id]), await read(db, 'SELECT COUNT(*) AS events FROM change_events')];
    const beforeFailure = await snapshot();
    await db.batch([sql("CREATE TRIGGER reject_handoff_comment BEFORE INSERT ON comments BEGIN SELECT RAISE(ABORT,'comment_rejected'); END")]);
    await assert.rejects(product({ op: 'claim_handoff', claim_proof: proof(failedTarget.receipt), expected_revision: failedTarget.receipt.revision, request_id: crypto.randomUUID(), tip: 'abcdef0' }), /comment_rejected/);
    await db.batch([sql('DROP TRIGGER reject_handoff_comment')]);
    assert.deepEqual(await snapshot(), beforeFailure);
    process.stdout.write(`PASS ${name} product: claim_handoff writes tip and summary comments, queue labels, and the release atomically, replays by request ID, and a failed comment write leaves nothing\n`);
    process.stdout.write(`PASS ${name} product: default expired own lease release conflict, opted-in expired own lease release no-op, other session, generation, and newer lease release conflict\n`);
    process.stdout.write(`PASS ${name} product: strict claim parser, generated inspection, immutable replay classification, closed acquisition, close/reopen fencing, force denial\n`);
    process.stdout.write(`PASS ${name}: concurrent acquisition and UUID admission, original receipt history, actor/session/payload conflicts, CAS, equality expiry, caller incarnation fencing, missing old receipt rejection, rollback sentinel, MAX counters, old proof with no claim row\n`);
  }
} finally { await sqlite.dispose(); await d1.dispose(); rmSync(directory, { recursive: true, force: true }); }
