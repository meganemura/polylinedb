// Shared by every transport, so each proves the same read-then-acquire sequence without a claim_show call.
import assert from 'node:assert/strict';
import type { OperationResult } from '../../src/records/index.ts';

export async function runShowClaimFlow(run: (value: Record<string, unknown>) => Promise<OperationResult>): Promise<void> {
  const created = await run({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'show-claim', body: 'Read then claim' });
  assert.ok('issue' in created); const id = created.issue.id;
  const before = await run({ op: 'show', id }); assert.ok('issue' in before && 'claim' in before);
  assert.equal(before.claim.state, 'never_claimed'); assert.equal(before.claim.lease, null); assert.match(before.claim.store_incarnation, /^[a-f0-9]{32}$/);
  const inspected = await run({ op: 'claim_show', issue_id: id }); assert.ok('claim' in inspected);
  assert.deepEqual({ ...before.claim, observed_at: 0 }, { ...inspected.claim, observed_at: 0 });
  const acquired = await run({ op: 'claim_acquire', issue_id: id, incarnation: before.claim.store_incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), agent_label: 'Codex' });
  assert.ok('claim_receipt' in acquired);
  const after = await run({ op: 'show', id }); assert.ok('issue' in after && 'claim' in after);
  const { outcome: _, ...lease } = acquired.claim_receipt;
  assert.deepEqual(after.claim, { issue_id: id, store_incarnation: before.claim.store_incarnation, observed_at: after.claim.observed_at, state: 'active', lease });
  assert.deepEqual(after.issue, before.issue);
  await assert.rejects(run({ op: 'show', id: 'pd-999' }), { code: 'not_found' });
}
