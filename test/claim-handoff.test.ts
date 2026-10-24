// Hands a claimed issue to the landing queue in one write: tip and result comments, the queue labels, and the release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeStore, openStore } from '../src/local-store/index.ts';
import { executeOperation, parseOperation } from '../src/records/index.ts';
import type { ClaimReceipt } from '../src/records/index.ts';

const request = () => crypto.randomUUID();
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pd-handoff-'));
  const location = { directory: join(root, 'store'), cwd: join(root, 'work') };
  initializeStore(location); const store = openStore(location);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const run = (value: unknown, actor: string | { id: string; kind: 'human' | 'agent' } = 'test:owner') => executeOperation(store.db, parseOperation(value), actor);
  return { run, db: store.db };
}
async function claimed(run: ReturnType<typeof fixture>['run'], labels = ['ready', 'ui'], status = 'in_progress') {
  const created = await run({ op: 'create', prefix: 'pd', request_id: request(), tool: 'pd', project: 'test', body: 'Work', labels });
  assert.ok('issue' in created);
  const shown = await run({ op: 'claim_show', issue_id: created.issue.id }); assert.ok('claim' in shown);
  const acquired = await run({ op: 'claim_acquire', issue_id: created.issue.id, incarnation: shown.claim.store_incarnation, session_id: request(), request_id: request() });
  assert.ok('claim_receipt' in acquired);
  if (status !== 'open') {
    const moved = await run({ op: 'update', id: created.issue.id, changes: [{ field: 'status', value: status, expected: 1 }], claim_proof: proof(acquired.claim_receipt) });
    assert.ok('issue' in moved);
  }
  return { id: created.issue.id, receipt: acquired.claim_receipt };
}
const proof = (receipt: ClaimReceipt) => ({ issue_id: receipt.issue_id, incarnation: receipt.incarnation, session_id: receipt.session_id, generation: receipt.generation });
async function state(run: ReturnType<typeof fixture>['run'], id: string) {
  const shown = await run({ op: 'show', id }); assert.ok('comments' in shown);
  const feed = await run({ op: 'changes', since: 0, issue_ids: [id], limit: 100 }); assert.ok('changes' in feed);
  return { issue: shown.issue, comments: shown.comments, claim: shown.claim.state, events: feed.changes.map(event => event.kind) };
}

test('handoff writes the tip and result comments, moves the issue to the landing queue, and releases the claim in one write', async t => {
  const { run } = fixture(t);
  const { id, receipt } = await claimed(run);
  const before = await state(run, id);
  const handoff = { op: 'claim_handoff', claim_proof: proof(receipt), expected_revision: receipt.revision, request_id: request(), tip: '1427713ba3901eb7c7d10f813448e8d03227c0f1', summary: 'Landed on queue.\nAll checks pass.' };
  const result = await run(handoff);
  assert.ok('handoff' in result);
  assert.equal(result.claim_receipt.outcome, 'released');
  assert.equal(result.claim_receipt.revision, receipt.revision + 1);
  assert.deepEqual(result.handoff.comments.map(comment => comment.body), ['tip: 1427713ba3901eb7c7d10f813448e8d03227c0f1', 'Landed on queue.\nAll checks pass.']);
  assert.deepEqual({ status: result.handoff.issue.status, labels: result.handoff.issue.labels }, { status: 'open', labels: ['main-wait', 'ui'] });
  assert.deepEqual({ status: result.handoff.issue.versions.status, labels: result.handoff.issue.versions.labels, body: result.handoff.issue.versions.body },
    { status: before.issue.versions.status + 1, labels: before.issue.versions.labels + 1, body: before.issue.versions.body });
  const after = await state(run, id);
  assert.deepEqual(after.issue, result.handoff.issue);
  assert.deepEqual(after.comments, result.handoff.comments.map(comment => ({ ...comment, stars: 0, starrers: [] })));
  assert.equal(after.claim, 'released');
  assert.deepEqual(after.events.slice(before.events.length).sort(), ['claim_released', 'commented', 'commented', 'status_changed']);

  assert.deepEqual(await run(handoff), result);
  assert.deepEqual(await state(run, id), after);
  await assert.rejects(run({ ...handoff, summary: 'Different' }), { code: 'claim_request_conflict' });
  await assert.rejects(run({ op: 'claim_release', claim_proof: proof(receipt), expected_revision: receipt.revision, request_id: handoff.request_id }), { code: 'claim_request_conflict' });
  assert.deepEqual(await state(run, id), after);
});

test('handoff without a summary on an issue already waiting for main writes only the tip and the release', async t => {
  const { run } = fixture(t);
  const { id, receipt } = await claimed(run, ['main-wait'], 'open');
  const before = await state(run, id);
  const result = await run({ op: 'claim_handoff', claim_proof: proof(receipt), expected_revision: receipt.revision, request_id: request(), tip: 'abc1234' });
  assert.ok('handoff' in result);
  assert.deepEqual(result.handoff.comments.map(comment => comment.body), ['tip: abc1234']);
  assert.deepEqual(result.handoff.issue, before.issue);
  const after = await state(run, id);
  assert.deepEqual(after.events.slice(before.events.length).sort(), ['claim_released', 'commented']);
});

test('a stale or foreign proof, a closed issue, and a failing comment write leave nothing behind', async t => {
  const { run, db } = fixture(t);
  const { id, receipt } = await claimed(run);
  const handoff = { op: 'claim_handoff', claim_proof: proof(receipt), expected_revision: receipt.revision, request_id: request(), tip: 'abcdef0', summary: 'Done.' };
  const before = await state(run, id);
  await assert.rejects(run({ ...handoff, expected_revision: receipt.revision + 1 }), { code: 'claim_conflict' });
  await assert.rejects(run({ ...handoff, request_id: request() }, 'test:other'), { code: 'claim_conflict' });
  assert.deepEqual(await state(run, id), before);

  await db.batch([{ sql: "CREATE TRIGGER reject_comment BEFORE INSERT ON comments BEGIN SELECT RAISE(ABORT,'comment_rejected'); END", params: [] }]);
  await assert.rejects(run({ ...handoff, request_id: request() }), /comment_rejected/);
  assert.deepEqual(await state(run, id), before);
  await db.batch([{ sql: 'DROP TRIGGER reject_comment', params: [] }]);

  const closed = await claimed(run, ['ready'], 'closed');
  const closedBefore = await state(run, closed.id);
  await assert.rejects(run({ op: 'claim_handoff', claim_proof: proof(closed.receipt), expected_revision: closed.receipt.revision, request_id: request(), tip: 'abcdef0' }), { code: 'conflict' });
  assert.deepEqual(await state(run, closed.id), closedBefore);
});

test('an agent hands off the issue it holds', async t => {
  const { run } = fixture(t);
  const agent = { id: 'local:agent', kind: 'agent' as const };
  const created = await run({ op: 'create', prefix: 'pd', request_id: request(), tool: 'pd', project: 'test', body: 'Agent work', labels: ['ready'] });
  assert.ok('issue' in created);
  const shown = await run({ op: 'claim_show', issue_id: created.issue.id }); assert.ok('claim' in shown);
  const acquired = await run({ op: 'claim_acquire', issue_id: created.issue.id, incarnation: shown.claim.store_incarnation, session_id: request(), request_id: request() }, agent);
  assert.ok('claim_receipt' in acquired);
  const result = await run({ op: 'claim_handoff', claim_proof: proof(acquired.claim_receipt), expected_revision: acquired.claim_receipt.revision, request_id: request(), tip: 'abcdef0' }, agent);
  assert.ok('handoff' in result);
  assert.deepEqual(result.handoff.issue.labels, ['main-wait']);
  assert.equal(result.handoff.comments[0]?.created_by, 'local:agent');
});

test('handoff input is strict', async () => {
  const proofValue = { issue_id: 'pd-1', incarnation: 'a'.repeat(32), session_id: request(), generation: 1 };
  const base = { op: 'claim_handoff', claim_proof: proofValue, expected_revision: 1, request_id: request(), tip: 'abcdef0' };
  assert.doesNotThrow(() => parseOperation(base));
  assert.doesNotThrow(() => parseOperation({ ...base, tip: 'a'.repeat(40) }));
  for (const bad of [{ tip: 'abc12' }, { tip: 'ABCDEF0' }, { tip: 'a'.repeat(41) }, { tip: undefined }, { summary: '   ' }, { summary: 'x\u0000' }, { summary: 'é'.repeat(32769) }, { extra: 1 }]) {
    assert.throws(() => parseOperation({ ...base, ...bad }), { code: 'invalid_input' }, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => parseOperation({ ...base, summary: 'é'.repeat(32768) }));
});
