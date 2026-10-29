// Shared by every transport, so each proves the same read-then-acquire sequence without a claim_show call.
import assert from 'node:assert/strict';
import type { OperationResult } from '../../src/records/index.ts';

export async function runShowClaimFlow(run: (value: Record<string, unknown>) => Promise<OperationResult>): Promise<void> {
  const created = await run({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'show-claim', body: 'Read then claim' });
  assert.ok('issue' in created); const id = created.issue.id;
  const before = await run({ op: 'show', id }); assert.ok('issue' in before && 'claim' in before);
  assert.equal(before.claim.state, 'never_claimed'); assert.equal(before.claim.lease, null); assert.match(before.claim.store_incarnation, /^[a-f0-9]{32}$/);
  assert.equal('run' in before.claim, false, 'an issue never claimed has no run');
  const inspected = await run({ op: 'claim_show', issue_id: id }); assert.ok('claim' in inspected);
  assert.deepEqual({ ...before.claim, observed_at: 0 }, { ...inspected.claim, observed_at: 0 });
  const acquired = await run({ op: 'claim_acquire', issue_id: id, incarnation: before.claim.store_incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), agent_label: 'Codex' });
  assert.ok('claim_receipt' in acquired);
  const after = await run({ op: 'show', id }); assert.ok('issue' in after && 'claim' in after);
  const { outcome: _, ...lease } = acquired.claim_receipt;
  assert.deepEqual(after.claim, { issue_id: id, store_incarnation: before.claim.store_incarnation, observed_at: after.claim.observed_at, state: 'active', lease,
    run: { state: 'working', quiet_after: 600, last: null } });
  assert.deepEqual(after.issue, before.issue);

  const claim_proof = { issue_id: id, incarnation: lease.incarnation, session_id: lease.session_id, generation: lease.generation };
  const report = { op: 'claim_report', claim_proof, kind: 'error', text: 'wrangler d1 execute fails: no such table', request_id: crypto.randomUUID() };
  const reported = await run(report); assert.ok('claim_receipt' in reported);
  assert.deepEqual({ revision: reported.claim_receipt.revision, expires_at: reported.claim_receipt.expires_at, outcome: reported.claim_receipt.outcome },
    { revision: lease.revision + 1, expires_at: lease.expires_at, outcome: 'renewed' }, 'a report needs no revision and keeps the deadline');
  assert.deepEqual(await run(report), reported, 'a retried report returns its receipt');
  const errored = { state: 'errored', quiet_after: 600, last: { kind: 'error', text: report.text, at: reported.claim_receipt.changed_at } };
  const shown = await run({ op: 'show', id }); assert.ok('claim' in shown); assert.deepEqual(shown.claim.run, errored);
  const reread = await run({ op: 'claim_show', issue_id: id }); assert.ok('claim' in reread); assert.deepEqual(reread.claim.run, errored);
  const listed = await run({ op: 'claim_list', tool: 'test', project: 'show-claim', limit: 100 }); assert.ok('claims' in listed);
  assert.deepEqual(listed.claims.find(claim => claim.issue_id === id)?.run, errored);
  await assert.rejects(run({ op: 'show', id: 'pd-999' }), { code: 'not_found' });
}

// Shared by SQLite and D1, so both prove that list's claimed filter reads the same claim states as show.
export async function runClaimedListFlow(run: (value: Record<string, unknown>) => Promise<OperationResult>, sql: (statement: string, ...params: string[]) => Promise<unknown>): Promise<void> {
  const tool = 'claimed'; const project = 'claimed-list';
  const create = async (body: string) => {
    const created = await run({ op: 'create', prefix: 'cl', request_id: crypto.randomUUID(), tool, project, body });
    assert.ok('issue' in created); return created.issue.id;
  };
  const start = async (id: string) => {
    const shown = await run({ op: 'show', id }); assert.ok('claim' in shown);
    const session_id = crypto.randomUUID();
    const acquired = await run({ op: 'claim_acquire', issue_id: id, incarnation: shown.claim.store_incarnation, session_id, request_id: crypto.randomUUID() });
    assert.ok('claim_receipt' in acquired);
    const claim_proof = { issue_id: id, incarnation: acquired.claim_receipt.incarnation, session_id, generation: acquired.claim_receipt.generation };
    await run({ op: 'update', id, changes: [{ field: 'status', value: 'in_progress', expected: 1 }], claim_proof });
    return claim_proof;
  };
  const never = await create('Never claimed');
  const active = await create('Active'); await start(active);
  const released = await create('Released');
  await run({ op: 'claim_release', claim_proof: await start(released), expected_revision: 1, request_id: crypto.randomUUID() });
  const expired = await create('Expired'); await start(expired);
  await sql('UPDATE issue_claims SET acquired_at = acquired_at - 1000, changed_at = changed_at - 1000, expires_at = acquired_at - 999 WHERE issue_id = ?', expired);
  const invalidated = await create('Invalidated'); await start(invalidated);
  await sql('UPDATE issue_claims SET incarnation = ? WHERE issue_id = ?', 'f'.repeat(32), invalidated);
  const states = await Promise.all([never, active, released, expired, invalidated].map(async id => {
    const shown = await run({ op: 'show', id }); assert.ok('claim' in shown); return shown.claim.state;
  }));
  assert.deepEqual(states, ['never_claimed', 'active', 'released', 'expired', 'invalidated']);

  const ids = async (filters: Record<string, unknown>) => {
    const page = await run({ op: 'list', ...filters }); assert.ok('issues' in page); return page.issues.map(issue => issue.id);
  };
  for (const scope of [{ project }, { tool }, { tool, project }]) {
    assert.deepEqual(await ids({ ...scope, claimed: true }), [active], JSON.stringify(scope));
    assert.deepEqual(await ids({ ...scope, claimed: false }), [never, released, expired, invalidated], JSON.stringify(scope));
    assert.deepEqual(await ids(scope), [never, active, released, expired, invalidated], JSON.stringify(scope));
  }
  assert.deepEqual(await ids({ tool, project, status: 'in_progress', claimed: false }), [released, expired, invalidated]);
  assert.deepEqual(await ids({ project, status: 'in_progress', claimed: true }), [active]);
  const first = await run({ op: 'list', project, claimed: false, limit: 1 });
  assert.ok('issues' in first);
  assert.deepEqual([first.issues.map(issue => issue.id), first.next_cursor], [[never], never]);
  assert.deepEqual(await ids({ project, claimed: false, after: never }), [released, expired, invalidated]);
}
