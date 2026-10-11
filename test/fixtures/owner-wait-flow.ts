// Runs the owner-wait scenario; SQLite and D1 callers supply the executor.
import assert from 'node:assert/strict';
import { executeOperation, parseOperation } from '../../src/records/index.ts';
import type { SqlExecutor } from '../../src/records/persistence.ts';

const agent = { id: 'local:codex', kind: 'agent' } as const;
const human = 'local:operator';

export async function runOwnerWaitFlow(db: SqlExecutor): Promise<void> {
  const run = (value: unknown, actor: string | typeof agent = human) => executeOperation(db, parseOperation(value), actor);
  const create = async (labels: string[], project = 'wait') => {
    const result = await run({ op: 'create', prefix: 'ow', request_id: crypto.randomUUID(), tool: 'wait', project, body: labels.join(' ') || 'plain', labels });
    assert.ok('issue' in result); return result.issue.id;
  };
  const link = async (dependent_id: string, blocker_id: string, expected_revision = 1) => run({ op: 'dependency_add', dependent_id, blocker_id, expected_revision, request_id: crypto.randomUUID() });
  const readyIds = async (actor: string | typeof agent) => {
    const result = await run({ op: 'dependency_worklist', state: 'ready', tool: 'wait', project: 'wait' }, actor);
    assert.ok('issues' in result); return result.issues.map(issue => issue.id);
  };

  const plain = await create(['ready']);
  const decision = await create(['ready', 'owner-decision']);
  const action = await create(['ready', 'owner-action']);
  const both = await create(['owner-action', 'owner-decision']);
  const mainWait = await create(['ready', 'main-wait']);
  const elsewhere = await create(['owner-action'], 'elsewhere');
  const closedWait = await create(['owner-action']);
  const dependentOne = await create(['ready']);
  const dependentTwo = await create([]);
  const dependentClosed = await create([]);
  await link(dependentOne, decision); await link(dependentTwo, decision); await link(dependentClosed, decision);
  await link(dependentTwo, action, 2);
  await run({ op: 'close', id: dependentClosed, expected: 1, force: true, reason: 'closed while its prerequisite waits' });
  await run({ op: 'close', id: closedWait, expected: 1 });

  for (const actor of [human, agent] as const) {
    const ids = await readyIds(actor);
    assert.ok(ids.includes(plain) && ids.includes(mainWait), 'main-wait and plain issues stay ready');
    for (const hidden of [decision, action, both]) assert.ok(!ids.includes(hidden), `the ready worklist hides ${hidden} for ${typeof actor === 'string' ? actor : actor.id}`);
  }
  const labeled = await run({ op: 'dependency_worklist', state: 'ready', label: 'owner-action' });
  assert.ok('issues' in labeled); assert.deepEqual(labeled.issues, [], 'naming the label does not reveal owner waits as ready');
  const blocked = await run({ op: 'dependency_worklist', state: 'blocked' });
  assert.ok('issues' in blocked); assert.ok(blocked.issues.some(issue => issue.id === dependentTwo), 'the blocked worklist is unchanged');

  const waits = await run({ op: 'dependency_owner_waits', tool: 'wait' });
  assert.ok('waits' in waits);
  assert.deepEqual(waits.waits.map(wait => wait.issue.id), [decision, action, both, elsewhere], 'unfinished owner waits in ID order');
  assert.deepEqual(waits.waits.map(wait => wait.dependents), [
    [{ id: dependentOne, project: 'wait', status: 'open' }, { id: dependentTwo, project: 'wait', status: 'open' }],
    [{ id: dependentTwo, project: 'wait', status: 'open' }], [], []]);
  assert.ok(waits.waits.every(wait => wait.dependents_next === null));
  assert.equal(waits.next_cursor, null);
  const scoped = await run({ op: 'dependency_owner_waits', tool: 'wait', project: 'elsewhere' }, agent);
  assert.ok('waits' in scoped); assert.deepEqual(scoped.waits.map(wait => wait.issue.id), [elsewhere]);
  const first = await run({ op: 'dependency_owner_waits', tool: 'wait', limit: 2 });
  assert.ok('waits' in first); assert.deepEqual(first.waits.map(wait => wait.issue.id), [decision, action]); assert.equal(first.next_cursor, action);
  const second = await run({ op: 'dependency_owner_waits', tool: 'wait', limit: 2, after: first.next_cursor });
  assert.ok('waits' in second); assert.deepEqual(second.waits.map(wait => wait.issue.id), [both, elsewhere]); assert.equal(second.next_cursor, null);

  const shown = await run({ op: 'show', id: decision });
  assert.ok('issue' in shown);
  await run({ op: 'update', id: decision, changes: [{ field: 'labels', value: ['ready'], expected: shown.issue.versions.labels }] });
  assert.ok((await readyIds(agent)).includes(decision), 'removing the owner label returns the issue to the ready worklist');
}
