// Shared by SQLite and D1, so both engines prove the same resource receipts, forward-only marks, close guard, feed events, and agent gate.
import assert from 'node:assert/strict';
import type { Actor, OperationResult } from '../../src/records/index.ts';

type Run = (value: Record<string, unknown>, caller?: string | Actor) => Promise<OperationResult>;
const request = () => crypto.randomUUID();
const agent: Actor = { id: 'agent:cleaner', kind: 'agent' };
const storeTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export async function runResourceFlow(run: Run, actor: string): Promise<void> {
  const create = async (body: string, extra: Record<string, unknown> = {}) => {
    const created = await run({ op: 'create', prefix: 'pd', request_id: request(), tool: 'test', project: 'cleanup', body, ...extra });
    assert.ok('issue' in created);
    return created.issue;
  };
  const issue = (await create('Spin up a preview database')).id;
  const head = await run({ op: 'changes', since: 0, limit: 100 }); assert.ok('next_since' in head);
  assert.deepEqual(await run({ op: 'resource_list', issue_id: issue }), { issue_id: issue, revision: 1, resources: [] });

  const add = { op: 'resource_add', issue_id: issue, kind: 'd1:database', name: 'preview-db', expected_revision: 1, request_id: request() };
  assert.deepEqual(await run(add), { resource_receipt: { issue_id: issue, seq: 1, revision: 2, outcome: 'added' } });
  assert.deepEqual(await run(add), { resource_receipt: { issue_id: issue, seq: 1, revision: 2, outcome: 'added' } }, 'the same request replays its receipt');
  await assert.rejects(run({ ...add, name: 'other-db' }), { code: 'resource_request_conflict' });
  await assert.rejects(run(add, 'someone:else'), { code: 'resource_request_conflict' });
  const listed = await run({ op: 'resource_list', issue_id: issue }); assert.ok('resources' in listed);
  const [planned] = listed.resources;
  assert.ok(planned && storeTime.test(planned.added_at));
  assert.deepEqual(listed, { issue_id: issue, revision: 2, resources: [{ issue_id: issue, seq: 1, kind: 'd1:database', name: 'preview-db', external_id: null,
    created_at: null, deleted_at: null, verified_deleted_at: null, verified_by: null, evidence: null, added_at: planned.added_at, added_by: actor, state: 'planned' }] });
  await assert.rejects(run({ ...add, kind: 'worker', name: 'api', request_id: request() }), { code: 'resource_conflict', details: { expected_revision: 1, current: listed } });
  assert.deepEqual(await run({ ...add, kind: 'worker', name: 'api', expected_revision: 2, request_id: request() }), { resource_receipt: { issue_id: issue, seq: 2, revision: 3, outcome: 'added' } });

  for (const invalid of [{ kind: 'D1' }, { kind: '-d1' }, { kind: 'k'.repeat(65) }, { name: 'two words' }, { name: 'tab\tname' }, { name: 'é'.repeat(129) }, { name: '' }]) {
    await assert.rejects(run({ ...add, ...invalid, expected_revision: 3, request_id: request() }), { code: 'invalid_input' }, JSON.stringify(invalid));
  }
  const update = { op: 'resource_update', issue_id: issue, seq: 1, request_id: request() };
  await assert.rejects(run({ ...update, expected_revision: 3 }), { code: 'invalid_input' }, 'an update names external_id, mark, or both');
  await assert.rejects(run({ ...update, expected_revision: 3, mark: 'verified_deleted', evidence: 'gone' }), { code: 'invalid_input' }, 'verified_deleted needs a claim proof');
  await assert.rejects(run({ ...update, expected_revision: 3, mark: 'deleted', evidence: 'gone' }), { code: 'invalid_input' }, 'evidence belongs to verified_deleted');
  await assert.rejects(run({ ...update, expected_revision: 3, external_id: 'uuid with space' }), { code: 'invalid_input' });
  await assert.rejects(run({ ...update, expected_revision: 3, seq: 9, mark: 'created' }), { code: 'not_found', details: { id: issue } });
  await assert.rejects(run({ ...update, expected_revision: 3, mark: 'deleted' }), { code: 'resource_mark_rejected', details: { resource: planned } }, 'a planned entry is created before it is deleted');

  assert.deepEqual(await run({ ...update, expected_revision: 3, external_id: 'c0ffee00-d1', mark: 'created' }), { resource_receipt: { issue_id: issue, seq: 1, revision: 4, outcome: 'updated' } });
  const created = await run({ op: 'resource_list', issue_id: issue }); assert.ok('resources' in created);
  const entry = created.resources[0]; assert.ok(entry && entry.created_at !== null && storeTime.test(entry.created_at));
  assert.deepEqual({ ...entry, created_at: 'store clock' }, { ...planned, external_id: 'c0ffee00-d1', created_at: 'store clock', state: 'created' });
  await assert.rejects(run({ ...update, expected_revision: 4, mark: 'created', request_id: request() }), { code: 'resource_mark_rejected', details: { resource: entry } });
  await assert.rejects(run({ ...update, expected_revision: 4, external_id: 'another-id', request_id: request() }), { code: 'resource_mark_rejected', details: { resource: entry } });
  assert.deepEqual(await run({ op: 'resource_list', issue_id: issue }), created, 'rejected marks change nothing');

  // A live entry keeps the issue open; force answers for prerequisites only.
  const shown = await run({ op: 'show', id: issue }); assert.ok('issue' in shown);
  const closeMessage = 'The issue still has external resources that are not verified deleted: d1:database:preview-db, worker:api. Mark each one verified_deleted with resource_update, or close with resources_reason.';
  await assert.rejects(run({ op: 'close', id: issue, expected: shown.issue.versions.status }), (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error && 'details' in error);
    assert.deepEqual([error.code, error.message, error.details], ['resources_remaining', closeMessage, undefined]);
    return true;
  });
  await assert.rejects(run({ op: 'close', id: issue, expected: shown.issue.versions.status, force: true, reason: 'ship it' }), { code: 'resources_remaining', message: closeMessage });
  await assert.rejects(run({ op: 'update', id: issue, changes: [{ field: 'status', value: 'closed', expected: shown.issue.versions.status }] }), { code: 'resources_remaining' });
  await assert.rejects(run({ op: 'update', id: issue, changes: [{ field: 'body', value: 'x', expected: 1 }], resources_reason: 'not a close' }), { code: 'invalid_input' });
  const stillOpen = await run({ op: 'show', id: issue }); assert.ok('comments' in stillOpen);
  assert.deepEqual([stillOpen.issue.status, stillOpen.comments], ['open', []]);

  const many = (await create('Many resources')).id;
  for (let index = 0; index < 7; index++) await run({ op: 'resource_add', issue_id: many, kind: 'r2:bucket', name: `b${index}`, expected_revision: index + 1, request_id: request() });
  await assert.rejects(run({ op: 'close', id: many, expected: 1 }), { code: 'resources_remaining',
    message: 'The issue still has external resources that are not verified deleted: r2:bucket:b0, r2:bucket:b1, r2:bucket:b2, r2:bucket:b3, r2:bucket:b4 and 2 more. Mark each one verified_deleted with resource_update, or close with resources_reason.' });
  const acknowledged = await run({ op: 'close', id: many, expected: 1, force: true, reason: 'prerequisites waived', resources_reason: 'the buckets hold the release artifacts' });
  assert.ok('issue' in acknowledged); assert.equal(acknowledged.issue.status, 'closed');
  const manyComments = await run({ op: 'show', id: many }); assert.ok('comments' in manyComments);
  assert.deepEqual(manyComments.comments.map(comment => [comment.body, comment.created_by]).sort(), [['prerequisites waived', actor], ['the buckets hold the release artifacts', actor]]);

  // Verifying a deletion needs evidence and a current claim proof, from every actor.
  assert.deepEqual(await run({ ...update, seq: 1, expected_revision: 4, mark: 'deleted', request_id: request() }), { resource_receipt: { issue_id: issue, seq: 1, revision: 5, outcome: 'updated' } });
  const inspection = await run({ op: 'claim_show', issue_id: issue }); assert.ok('claim' in inspection);
  const acquired = await run({ op: 'claim_acquire', issue_id: issue, incarnation: inspection.claim.store_incarnation, session_id: request(), request_id: request() });
  assert.ok('claim_receipt' in acquired);
  const proof = { issue_id: issue, incarnation: acquired.claim_receipt.incarnation, session_id: acquired.claim_receipt.session_id, generation: acquired.claim_receipt.generation };
  const verify = { ...update, seq: 1, expected_revision: 5, mark: 'verified_deleted', evidence: 'wrangler d1 list no longer shows c0ffee00-d1', request_id: request() };
  await assert.rejects(run({ ...verify, claim_proof: { ...proof, generation: proof.generation + 1 } }), { code: 'claim_required', details: { id: issue } });
  await assert.rejects(run({ ...verify, claim_proof: proof, evidence: 'e'.repeat(1025) }), { code: 'invalid_input' });
  assert.deepEqual(await run({ ...verify, claim_proof: proof }), { resource_receipt: { issue_id: issue, seq: 1, revision: 6, outcome: 'updated' } });
  const settled = await run({ op: 'resource_list', issue_id: issue }); assert.ok('resources' in settled);
  const verified = settled.resources[0]; assert.ok(verified);
  assert.deepEqual([verified.state, verified.verified_by, verified.evidence, verified.deleted_at !== null, verified.verified_deleted_at !== null], ['verified_deleted', actor, verify.evidence, true, true]);
  await assert.rejects(run({ ...update, seq: 1, expected_revision: 6, external_id: 'late', request_id: request() }), { code: 'resource_mark_rejected', details: { resource: verified } });

  assert.deepEqual(await run({ op: 'resource_live', project: 'cleanup', limit: 1 }), { entries: [{ issue: { id: issue, project: 'cleanup', status: 'open' }, resources: [settled.resources[1]] }], next_cursor: issue });
  const nextPage = await run({ op: 'resource_live', project: 'cleanup', after: issue, limit: 1 }); assert.ok('entries' in nextPage);
  assert.deepEqual(nextPage.entries.map(entry => [entry.issue.id, entry.issue.status, entry.resources.length]), [[many, 'closed', 7]]);
  assert.equal(nextPage.next_cursor, null);
  assert.deepEqual(await run({ op: 'resource_live', project: 'elsewhere' }), { entries: [], next_cursor: null });

  // A planned entry that was never created settles straight to verified_deleted.
  assert.deepEqual(await run({ ...update, seq: 2, expected_revision: 6, mark: 'verified_deleted', evidence: 'never created', claim_proof: proof, request_id: request() }),
    { resource_receipt: { issue_id: issue, seq: 2, revision: 7, outcome: 'updated' } });
  const closable = await run({ op: 'show', id: issue }); assert.ok('issue' in closable);
  const closed = await run({ op: 'close', id: issue, expected: closable.issue.versions.status, claim_proof: proof });
  assert.ok('issue' in closed); assert.equal(closed.issue.status, 'closed');

  // An epic answers only for its own entries.
  const epic = (await create('Epic', { type: 'epic' })).id;
  const child = (await create('Child', { parent: epic })).id;
  await run({ op: 'resource_add', issue_id: child, kind: 'worker', name: 'child-api', expected_revision: 1, request_id: request() });
  const epicClosed = await run({ op: 'close', id: epic, expected: 1 }); assert.ok('issue' in epicClosed);
  assert.equal(epicClosed.issue.status, 'closed');
  await assert.rejects(run({ op: 'close', id: child, expected: 1 }), { code: 'resources_remaining' });

  // The feed reports each committed entry change as an update with the resources facet; replays and rejections record nothing.
  const feed = await run({ op: 'changes', since: head.next_since, incarnation: head.incarnation, issue_ids: [issue], limit: 100 }); assert.ok('changes' in feed);
  assert.deepEqual(feed.changes.filter(event => event.fields.includes('resources')).map(event => [event.kind, event.fields, event.actor]),
    Array.from({ length: 6 }, () => ['updated', ['resources'], actor]));

  // An agent records resources only on an issue it holds a claim on.
  const own = (await create('Agent work', { labels: ['ready'] })).id;
  const agentAdd = { op: 'resource_add', issue_id: own, kind: 'worker', name: 'agent-api', expected_revision: 1, request_id: request() };
  await assert.rejects(run(agentAdd, agent), { code: 'claim_required', details: { id: own } });
  assert.deepEqual(await run({ op: 'resource_list', issue_id: own }), { issue_id: own, revision: 1, resources: [] });
  const agentView = await run({ op: 'claim_show', issue_id: own }, agent); assert.ok('claim' in agentView);
  await run({ op: 'claim_acquire', issue_id: own, incarnation: agentView.claim.store_incarnation, session_id: request(), request_id: request() }, agent);
  assert.deepEqual(await run(agentAdd, agent), { resource_receipt: { issue_id: own, seq: 1, revision: 2, outcome: 'added' } });
}
