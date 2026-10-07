// Interleaves a competing change right before each gated write batch; SQLite and D1 callers supply the executor.
import assert from 'node:assert/strict';
import { executeOperation, parseOperation } from '../../src/records/index.ts';
import type { SqlExecutor } from '../../src/records/persistence.ts';

const session = '00000000-0000-4000-8000-0000000000d1';
const codex = { id: 'local:codex', kind: 'agent' } as const;
const claude = { id: 'local:claude', kind: 'agent' } as const;
const human = 'local:operator';

function racing(db: SqlExecutor, interfere: () => Promise<void>): SqlExecutor {
  let pending: (() => Promise<void>) | undefined = interfere;
  return { reads: db.reads, async batch(statements) {
    const step = pending; pending = undefined;
    if (step) await step();
    return db.batch(statements);
  } };
}

export async function runGateRaces(db: SqlExecutor, prefix: string): Promise<string[]> {
  let sequence = 0;
  const run = (target: SqlExecutor, value: unknown, actor: string | typeof codex | typeof claude = human) => executeOperation(target, parseOperation(value), actor);
  const sql = async (statement: string, ...params: (string | number)[]) => (await db.batch([{ sql: statement, params }]))[0]?.rows ?? [];
  const incarnation = async () => String((await sql('SELECT incarnation FROM memory_store_identity WHERE singleton = 1'))[0]?.incarnation);
  const create = async (labels: string[]) => {
    const result = await run(db, { op: 'create', prefix: `${prefix}${++sequence}`, request_id: crypto.randomUUID(), tool: 'race', project: 'race', body: 'start', labels });
    assert.ok('issue' in result); return result.issue.id;
  };
  const acquire = async (id: string, actor: typeof codex | typeof claude) => {
    const result = await run(db, { op: 'claim_acquire', issue_id: id, incarnation: await incarnation(), session_id: session, request_id: crypto.randomUUID(), ttl: 300 }, actor);
    assert.ok('claim_receipt' in result); return result.claim_receipt;
  };
  const release = async (id: string, receipt: { incarnation: string; generation: number; revision: number }, actor: typeof codex | typeof claude) => {
    await run(db, { op: 'claim_release', claim_proof: { issue_id: id, incarnation: receipt.incarnation, session_id: session, generation: receipt.generation }, expected_revision: receipt.revision, request_id: crypto.randomUUID() }, actor);
  };
  const state = async (id: string) => {
    const issue = (await sql('SELECT body, body_v FROM issues WHERE id = ?', id))[0];
    const comments = (await sql('SELECT COUNT(*) AS n FROM comments WHERE issue_id = ?', id))[0]?.n;
    const edges = (await sql('SELECT COUNT(*) AS n FROM dependencies WHERE dependent_id = ?', id))[0]?.n;
    return { body: issue?.body, body_v: issue?.body_v, comments, edges };
  };
  const writes = (id: string, blocker: string) => ({
    comment: { op: 'comment', id, body: 'late' },
    update: { op: 'update', id, changes: [{ field: 'body', value: 'late', expected: 1 }] },
    dependency_add: { op: 'dependency_add', dependent_id: id, blocker_id: blocker, expected_revision: 1, request_id: crypto.randomUUID() },
  });
  const interferences = {
    released: async (id: string, receipt: Awaited<ReturnType<typeof acquire>>) => { await release(id, receipt, codex); },
    expired: async (id: string) => { await sql('UPDATE issue_claims SET acquired_at = acquired_at - 1000, changed_at = changed_at - 1000, expires_at = acquired_at - 999 WHERE issue_id = ?', id); },
    reacquired: async (id: string, receipt: Awaited<ReturnType<typeof acquire>>) => { await release(id, receipt, codex); await acquire(id, claude); },
  };
  const covered: string[] = [];
  for (const [name, interfere] of Object.entries(interferences)) {
    for (const kind of ['comment', 'update', 'dependency_add'] as const) {
      const id = await create(['ready']); const blocker = await create([]);
      const receipt = await acquire(id, codex);
      const before = await state(id);
      const write = writes(id, blocker)[kind];
      await assert.rejects(run(racing(db, () => interfere(id, receipt)), write, codex), { code: 'claim_required' }, `${kind} after ${name}`);
      assert.deepEqual(await state(id), before, `${kind} after ${name} wrote nothing`);
      covered.push(`${kind} after ${name}`);
    }
  }
  const id = await create(['ready']);
  const removeReady = async () => { await run(db, { op: 'update', id, changes: [{ field: 'labels', value: [], expected: 1 }] }); };
  await assert.rejects(run(racing(db, removeReady), { op: 'claim_acquire', issue_id: id, incarnation: await incarnation(), session_id: session, request_id: crypto.randomUUID(), ttl: 300 }, codex),
    { code: 'not_ready' }, 'acquisition after the ready label was removed');
  assert.equal((await sql('SELECT COUNT(*) AS n FROM issue_claims WHERE issue_id = ?', id))[0]?.n, 0, 'no claim after the ready label was removed');
  covered.push('claim_acquire after ready removal');
  return covered;
}
