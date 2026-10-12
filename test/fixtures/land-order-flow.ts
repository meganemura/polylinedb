// Shared by SQLite and D1, so both engines prove the same land-order receipts, cycle checks, feed events, and handoff warnings.
import assert from 'node:assert/strict';
import type { Actor, OperationResult } from '../../src/records/index.ts';

type Run = (value: Record<string, unknown>, caller?: string | Actor) => Promise<OperationResult>;
const request = () => crypto.randomUUID();
const agent: Actor = { id: 'agent:lander', kind: 'agent' };

export async function runLandOrderFlow(run: Run, actor: string): Promise<void> {
  const create = async (body: string, labels: string[] = []) => {
    const created = await run({ op: 'create', prefix: 'pd', request_id: request(), tool: 'test', project: 'landing', body, labels });
    assert.ok('issue' in created);
    return created.issue.id;
  };
  const later = await create('Later');
  const earlier = await create('Earlier');
  const third = await create('Third');
  const queued = await create('Queued', ['main-wait']);
  const done = await create('Done');
  await run({ op: 'close', id: done, expected: 1 });
  const head = await run({ op: 'changes', since: 0, limit: 100 }); assert.ok('next_since' in head);

  const add = { op: 'land_order_add', later_id: later, earlier_id: earlier, expected_revision: 1, request_id: request() };
  assert.deepEqual(await run(add), { land_order_receipt: { later_id: later, earlier_id: earlier, revision: 2, outcome: 'added' } });
  assert.deepEqual(await run(add), { land_order_receipt: { later_id: later, earlier_id: earlier, revision: 2, outcome: 'added' } }, 'the same request replays its receipt');
  await assert.rejects(run({ ...add, earlier_id: third }), { code: 'land_order_request_conflict' });
  await assert.rejects(run(add, 'someone:else'), { code: 'land_order_request_conflict' });
  assert.deepEqual(await run({ ...add, expected_revision: 2, request_id: request() }), { land_order_receipt: { later_id: later, earlier_id: earlier, revision: 3, outcome: 'already_present' } });

  const stale = run({ ...add, earlier_id: third, request_id: request() });
  await assert.rejects(stale, { code: 'land_order_conflict', details: { expected_revision: 1, current: {
    issue_id: later, revision: 3, after: [{ id: earlier, project: 'landing', status: 'open' }], before: [] } } });

  assert.deepEqual(await run({ op: 'land_order_list', issue_id: earlier }), { issue_id: earlier, revision: 1, after: [], before: [{ id: later, project: 'landing', status: 'open' }] });
  await assert.rejects(run({ op: 'land_order_list', issue_id: 'pd-99' }), { code: 'not_found', details: { id: 'pd-99' } });
  await assert.rejects(run({ ...add, earlier_id: 'pd-99', expected_revision: 3, request_id: request() }), { code: 'not_found', details: { id: 'pd-99' } });

  // Every rejected cycle leaves the revision and the receipts as they were.
  const unchanged = await run({ op: 'land_order_list', issue_id: earlier });
  await assert.rejects(run({ op: 'land_order_add', later_id: third, earlier_id: third, expected_revision: 1, request_id: request() }), { code: 'dependency_cycle' });
  await assert.rejects(run({ op: 'land_order_add', later_id: earlier, earlier_id: later, expected_revision: 1, request_id: request() }), { code: 'dependency_cycle' });
  await run({ op: 'dependency_add', dependent_id: third, blocker_id: later, expected_revision: 1, request_id: request() });
  await assert.rejects(run({ op: 'land_order_add', later_id: earlier, earlier_id: third, expected_revision: 1, request_id: request() }), { code: 'dependency_cycle' }, 'land order closing a cycle through a prerequisite');
  await assert.rejects(run({ op: 'dependency_add', dependent_id: earlier, blocker_id: third, expected_revision: 1, request_id: request() }), { code: 'dependency_cycle' }, 'a prerequisite closing a cycle through land order');
  assert.deepEqual(await run({ op: 'land_order_list', issue_id: earlier }), unchanged);
  const prerequisites = await run({ op: 'dependency_list', dependent_id: earlier }); assert.ok('revision' in prerequisites);
  assert.equal(prerequisites.revision, 1);

  // Land order never blocks: the later issue is ready while the issue it lands after is open.
  const ready = await run({ op: 'dependency_worklist', state: 'ready', project: 'landing' }); assert.ok('issues' in ready);
  assert.deepEqual(ready.issues.map(issue => issue.id), [later, earlier, queued]);

  const shown = await run({ op: 'show', id: later, with_land_order: true });
  assert.ok('land_order' in shown);
  assert.deepEqual(shown.land_order, { issue_id: later, revision: 3, after: [{ id: earlier, project: 'landing', status: 'open' }], before: [] });
  const plain = await run({ op: 'show', id: later }); assert.equal('land_order' in plain, false);
  const listed = await run({ op: 'list', project: 'landing', tool: 'test', with_land_order: true });
  assert.ok('land_order' in listed && Array.isArray(listed.land_order));
  assert.deepEqual(listed.land_order.map(order => [order.issue_id, order.after.map(entry => entry.id), order.before.map(entry => entry.id)]),
    [[later, [earlier], []], [earlier, [], [later]], [third, [], []], [queued, [], []], [done, [], []]]);

  // A handoff warns about each direct predecessor that is neither closed nor waiting on main.
  await run({ op: 'land_order_add', later_id: later, earlier_id: queued, expected_revision: 3, request_id: request() });
  await run({ op: 'land_order_add', later_id: later, earlier_id: done, expected_revision: 4, request_id: request() });
  const inspection = await run({ op: 'claim_show', issue_id: later }); assert.ok('claim' in inspection);
  const acquired = await run({ op: 'claim_acquire', issue_id: later, incarnation: inspection.claim.store_incarnation, session_id: request(), request_id: request() });
  assert.ok('claim_receipt' in acquired);
  const receipt = acquired.claim_receipt;
  const handoff = await run({ op: 'claim_handoff', claim_proof: { issue_id: later, incarnation: receipt.incarnation, session_id: receipt.session_id, generation: receipt.generation },
    expected_revision: receipt.revision, request_id: request(), tip: 'abcdef0' });
  assert.ok('handoff' in handoff);
  assert.deepEqual('land_order_warnings' in handoff ? handoff.land_order_warnings : undefined, [{ id: earlier, status: 'open' }]);

  const removed = { op: 'land_order_remove', later_id: later, earlier_id: earlier, expected_revision: 5, request_id: request() };
  assert.deepEqual(await run(removed), { land_order_receipt: { later_id: later, earlier_id: earlier, revision: 6, outcome: 'removed' } });
  assert.deepEqual(await run({ ...removed, expected_revision: 6, request_id: request() }), { land_order_receipt: { later_id: later, earlier_id: earlier, revision: 7, outcome: 'already_absent' } });

  // The feed names the land-order edges on the later issue and never reports a readiness change for them.
  const feed = await run({ op: 'changes', since: head.next_since, incarnation: head.incarnation, issue_ids: [later, earlier], limit: 100 }); assert.ok('changes' in feed);
  assert.deepEqual(feed.changes.filter(event => event.kind.startsWith('dependency_')).map(event => [event.issue_id, event.kind, event.relation, event.actor]), [
    [later, 'dependency_added', 'lands_after', actor], [later, 'dependency_added', 'lands_after', actor], [later, 'dependency_added', 'lands_after', actor],
    [later, 'dependency_removed', 'lands_after', actor]]);
  assert.equal(feed.changes.some(event => event.kind === 'became_ready'), false);

  // An agent writes land order only for an issue it holds a claim on.
  const own = await create('Agent work', ['ready']);
  const agentAdd = { op: 'land_order_add', later_id: own, earlier_id: earlier, expected_revision: 1, request_id: request() };
  await assert.rejects(run(agentAdd, agent), { code: 'claim_required', details: { id: own } });
  assert.deepEqual(await run({ op: 'land_order_list', issue_id: own }), { issue_id: own, revision: 1, after: [], before: [] });
  const agentView = await run({ op: 'claim_show', issue_id: own }, agent); assert.ok('claim' in agentView);
  await run({ op: 'claim_acquire', issue_id: own, incarnation: agentView.claim.store_incarnation, session_id: request(), request_id: request() }, agent);
  assert.deepEqual(await run(agentAdd, agent), { land_order_receipt: { later_id: own, earlier_id: earlier, revision: 2, outcome: 'added' } });

  const closable = await create('Closable');
  await run({ op: 'land_order_add', later_id: closable, earlier_id: earlier, expected_revision: 1, request_id: request() });
  const closed = await run({ op: 'close', id: closable, expected: 1 });
  assert.ok('issue' in closed);
  assert.equal(closed.issue.status, 'closed', 'an issue closes while the issue it lands after is open');
}
