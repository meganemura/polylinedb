// Shared by every transport that reports closure, so SQLite, D1, and MCP prove the same close and reopen semantics.
import assert from 'node:assert/strict';
import type { Issue, OperationResult } from '../../src/records/index.ts';

type Run = (value: Record<string, unknown>) => Promise<OperationResult>;
const issueOf = (result: OperationResult): Issue => { assert.ok('issue' in result); return result.issue; };
const closure = (issue: Issue) => [issue.closed_at, issue.closed_by];

export async function runClosureFlow(run: Run, actor: string): Promise<void> {
  const create = (fields: Record<string, unknown> = {}) => run({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'test', project: 'closure', body: 'Closure', ...fields });

  const created = issueOf(await create());
  assert.deepEqual(closure(created), [null, null], 'an open issue has no closure');

  const closed = issueOf(await run({ op: 'close', id: created.id, expected: 1 }));
  assert.deepEqual(closure(closed), [closed.updated_at, actor], 'close records its write time and actor');

  await new Promise(resolve => setTimeout(resolve, 5));
  const edited = issueOf(await run({ op: 'update', id: created.id, changes: [{ field: 'body', value: 'Edited after close', expected: 1 }] }));
  assert.notEqual(edited.updated_at, closed.updated_at, 'the edit moves updated_at');
  assert.deepEqual(closure(edited), closure(closed), 'an edit after close keeps the closure');

  const reclosed = issueOf(await run({ op: 'update', id: created.id, changes: [{ field: 'status', value: 'closed', expected: 2 }] }));
  assert.deepEqual(closure(reclosed), closure(closed), 'closing a closed issue keeps the first closure');

  const shown = await run({ op: 'show', id: created.id }); assert.ok('comments' in shown);
  assert.deepEqual(closure(shown.issue), closure(closed), 'show reports the closure');
  const listed = await run({ op: 'list', tool: 'test', project: 'closure', status: 'closed' }); assert.ok('issues' in listed);
  assert.deepEqual(listed.issues.map(issue => [issue.id, ...closure(issue)]), [[created.id, ...closure(closed)]], 'list reports the closure');

  const reopened = issueOf(await run({ op: 'reopen', id: created.id, expected: 3 }));
  assert.deepEqual(closure(reopened), [null, null], 'reopen clears the closure');

  const started = issueOf(await run({ op: 'close', id: created.id, expected: 4 }));
  const moved = issueOf(await run({ op: 'update', id: created.id, changes: [{ field: 'status', value: 'in_progress', expected: 5 }] }));
  assert.deepEqual(closure(started), [started.updated_at, actor]);
  assert.deepEqual(closure(moved), [null, null], 'any status change away from closed clears the closure');

  const born = issueOf(await create({ status: 'closed' }));
  assert.deepEqual(closure(born), [born.created_at, actor], 'creation with status closed records the creation time');

  const blocker = issueOf(await create());
  const blocked = issueOf(await create());
  await run({ op: 'dependency_add', dependent_id: blocked.id, blocker_id: blocker.id, expected_revision: 1, request_id: crypto.randomUUID() });
  await assert.rejects(run({ op: 'close', id: blocked.id, expected: 1 }), { code: 'dependency_blocked' });
  const forced = issueOf(await run({ op: 'close', id: blocked.id, expected: 1, force: true, reason: 'Closing over an open prerequisite' }));
  assert.deepEqual(closure(forced), [forced.updated_at, actor], 'a forced close records the closure');

  const conflict = await run({ op: 'close', id: created.id, expected: 1 }).then(() => undefined, (error: unknown) => error);
  assert.ok(conflict instanceof Error && 'code' in conflict && conflict.code === 'conflict', 'a stale close is a conflict');
  const unchanged = await run({ op: 'show', id: created.id }); assert.ok('comments' in unchanged);
  assert.deepEqual(closure(unchanged.issue), [null, null], 'a rejected close writes no closure');
}
