// Runs the publish sequence with a per-repository lock issue and a tip comment; SQLite and D1 callers supply the executor.
import assert from 'node:assert/strict';
import { executeOperation, parseOperation } from '../../src/records/index.ts';
import type { SqlExecutor } from '../../src/records/persistence.ts';

const codex = { id: 'local:codex', kind: 'agent' } as const;
const claude = { id: 'local:claude', kind: 'agent' } as const;
const human = 'local:operator';
type Agent = typeof codex | typeof claude;

export async function runMainLockFlow(db: SqlExecutor): Promise<void> {
  const run = (value: unknown, actor: string | Agent = human) => executeOperation(db, parseOperation(value), actor);
  const create = async (body: string, labels: string[], type = 'task') => {
    const result = await run({ op: 'create', prefix: 'ml', request_id: crypto.randomUUID(), tool: 'lock', project: 'lock', body, labels, type });
    assert.ok('issue' in result); return result.issue.id;
  };
  const shown = await run({ op: 'claim_show', issue_id: await create('main-lock: owner/repo', ['main-lock', 'ready'], 'chore') });
  assert.ok('claim' in shown);
  const lock = shown.claim.issue_id; const incarnation = shown.claim.store_incarnation;
  const work = await create('work item', ['ready']);
  const sessions = { 'local:codex': '00000000-0000-4000-8000-0000000000e1', 'local:claude': '00000000-0000-4000-8000-0000000000e2' };
  const acquire = (issue_id: string, agent: Agent, ttl = 300) => run({ op: 'claim_acquire', issue_id, incarnation, session_id: sessions[agent.id], request_id: crypto.randomUUID(), ttl }, agent);
  const proof = (issue_id: string, agent: Agent, generation: number) => ({ issue_id, incarnation, session_id: sessions[agent.id], generation });

  for (const actor of [human, codex] as const) {
    for (const label of [undefined, 'ready', 'main-lock']) {
      if (actor !== human && label === 'main-lock') continue;
      const ready = await run({ op: 'dependency_worklist', state: 'ready', ...(label ? { label } : {}) }, actor);
      assert.ok('issues' in ready);
      assert.ok(!ready.issues.some(issue => issue.id === lock), `the ready worklist hides the lock issue (${typeof actor === 'string' ? actor : actor.id}, ${label ?? 'no label'})`);
    }
  }
  const found = await run({ op: 'list', tool: 'lock', project: 'lock', label: 'main-lock' }, codex);
  assert.ok('issues' in found); assert.deepEqual(found.issues.map(issue => issue.id), [lock]);

  const held = await acquire(work, codex);
  assert.ok('claim_receipt' in held);
  const locked = await acquire(lock, codex, 120);
  assert.ok('claim_receipt' in locked);
  await assert.rejects(acquire(lock, claude, 120), { code: 'claim_conflict' }, 'a second agent cannot hold the main-lock');

  const tip = 'a'.repeat(40);
  await assert.rejects(run({ op: 'comment', id: work, body: `tip: ${tip}` }, claude), { code: 'claim_required' }, 'only the issue holder writes the tip');
  const pointer = await run({ op: 'comment', id: work, body: `tip: ${tip}` }, codex);
  assert.ok('comment' in pointer); assert.equal(pointer.comment.created_by, 'local:codex');

  await run({ op: 'claim_release', claim_proof: proof(lock, codex, locked.claim_receipt.generation), expected_revision: locked.claim_receipt.revision, request_id: crypto.randomUUID() }, codex);
  const next = await acquire(lock, claude, 120);
  assert.ok('claim_receipt' in next, 'the next agent takes the main-lock after release');

  const before = await run({ op: 'show', id: work });
  assert.ok('comments' in before);
  await run({ op: 'close', id: work, expected: before.issue.versions.status, claim_proof: proof(work, codex, held.claim_receipt.generation) }, codex);
  const current = await run({ op: 'claim_show', issue_id: work });
  assert.ok('claim' in current && current.claim.lease);
  await run({ op: 'claim_release', claim_proof: proof(work, codex, held.claim_receipt.generation), expected_revision: current.claim.lease.revision, request_id: crypto.randomUUID() }, codex);
  const after = await run({ op: 'show', id: work });
  assert.ok('comments' in after);
  assert.equal(after.issue.status, 'closed');
  assert.deepEqual(after.comments.map(comment => comment.body), [`tip: ${tip}`]);
  const released = await run({ op: 'claim_show', issue_id: work });
  assert.ok('claim' in released); assert.equal(released.claim.state, 'released');
}
