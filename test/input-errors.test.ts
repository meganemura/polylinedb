// Pins the invalid_input wording that MCP and CLI callers see when operation fields do not match a schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOperation } from "../src/records/operations.ts";

const secret = 'VAL-SENTINEL-89';
function rejection(input: Record<string, unknown>): string {
  try { parseOperation(input); } catch (error) {
    assert.equal((error as { code?: unknown }).code, 'invalid_input');
    const { message } = error as Error;
    assert.ok(!message.includes(secret), 'error messages do not echo caller values');
    return message;
  }
  return assert.fail('operation was accepted');
}
const memory = { op: 'memory_create', project: secret, prefix: 'pd', request_id: crypto.randomUUID(), title: secret, body: secret };
const change = { field: 'body', value: secret, expected: 1 };
const proof = { issue_id: 'pd-1', incarnation: 'f'.repeat(32), session_id: crypto.randomUUID(), generation: 1 };

test('memory_create names an unexpected tool field', () => {
  assert.equal(rejection({ ...memory, tool: secret }), 'Unexpected field: tool');
});

test('memory_create names a missing title field', () => {
  const { title: _, ...input } = memory;
  assert.equal(rejection(input), 'Missing field: title');
});

test('one rejection lists every unexpected field and then every missing field', () => {
  const { title: _, body: __, ...input } = memory;
  assert.equal(rejection({ ...input, tool: secret, labels: [secret] }), 'Unexpected fields: tool, labels; missing fields: title, body');
});

test('update names changes and array when changes is an object', () => {
  assert.equal(rejection({ op: 'update', id: 'pd-1', changes: change }), 'changes: expected array');
});

test('update names the path of a nested change', () => {
  assert.equal(rejection({ op: 'update', id: 'pd-1', changes: [change, secret] }), 'changes[1]: expected object');
  const { expected: _, ...partial } = change;
  assert.equal(rejection({ op: 'update', id: 'pd-1', changes: [change, { ...partial, field: 'status', note: secret }] }),
    'Unexpected field: changes[1].note; missing field: changes[1].expected');
});

test('claim_proof names a missing nested field', () => {
  const { generation: _, ...partial } = proof;
  assert.equal(rejection({ op: 'claim_release', claim_proof: partial, expected_revision: 1, request_id: crypto.randomUUID() }), 'Missing field: claim_proof.generation');
});

test('claim and dependency operations list every field problem', () => {
  assert.equal(rejection({ op: 'claim_show', clock: secret, tool: secret }), 'Unexpected fields: clock, tool; missing field: issue_id');
  assert.equal(rejection({ op: 'dependency_add', dependent_id: 'pd-1', note: secret }), 'Unexpected field: note; missing fields: blocker_id, expected_revision, request_id');
});
