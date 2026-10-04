// Checks the authenticated response boundary without accessing credentials or external hosts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCloudOperation } from '../src/cloud-client/cloud-operations.ts';
import { parseOperation } from "../src/records/operations.ts";

const entry = { id: 'pd-m1', project: 'demo', title: 'Fact', body: 'Verified', version: 2,
  created_at: '2026-01-01T00:00:00Z', created_by: 'access:owner', updated_at: '2026-01-02T00:00:00Z', updated_by: 'access:owner' };
const origin = 'https://memory.example';
const context = { project: 'demo', store: { kind: 'cloud', url: origin }, memories: [entry], limits: { entries: 20, bytes: 32768 }, omitted: false, next_cursor: null, notices: [] };
const call = (operation: unknown, response: unknown, status = 200) => executeCloudOperation({ origin, operation: parseOperation(operation), authorize: async () => 'synthetic-token', fetch: async () => Response.json(response, { status }) });

test('cloud validates memory scope, context identity, omission, and conflict payloads', async () => {
  assert.deepEqual(await call({ op: 'memory_context', project: 'demo' }, context), context);
  for (const invalid of [{ ...context, project: 'other' }, { ...context, store: { kind: 'cloud', url: 'https://other.example' } }, { ...context, omitted: true }, { ...context, memories: [{ ...entry, project: 'other' }] }, { ...context, memories: [{ ...entry, body: 'x'.repeat(40000) }] }]) {
    await assert.rejects(call({ op: 'memory_context', project: 'demo' }, invalid), { code: 'cloud_invalid_response' });
  }
  assert.deepEqual(await call({ op: 'memory_show', project: 'demo', id: 'pd-m1' }, { memory: entry }), { memory: entry });
  await assert.rejects(call({ op: 'memory_delete', project: 'demo', id: 'pd-m1', expected: 1 }, { error: { code: 'memory_conflict', message: 'Changed', details: { memory: entry, expected: 1 } } }, 409), { code: 'memory_conflict' });
  await assert.rejects(call({ op: 'memory_show', project: 'demo', id: 'pd-m1' }, { error: { code: 'memory_not_found', message: 'Missing', details: { project: 'demo', id: 'pd-m1' } } }, 404), { code: 'memory_not_found' });
});

test('ambiguous cloud memory creation exposes the retained request ID', async () => {
  const request_id = crypto.randomUUID();
  await assert.rejects(executeCloudOperation({ origin, operation: parseOperation({ op: 'memory_create', project: 'demo', prefix: 'pd', title: 'Fact', body: 'Confirmed', request_id }), authorize: async () => 'synthetic-token', fetch: async () => { throw new Error('response lost'); } }), error => {
    assert(error && typeof error === 'object' && 'details' in error);
    assert.deepEqual(error.details, { request_id });
    return true;
  });
});

test('cloud rejects memory error details from a different operation scope', async () => {
  for (const details of [{ project: 'other', id: 'pd-m1' }, { project: 'demo', id: 'pd-m2' }]) {
    await assert.rejects(call({ op: 'memory_show', project: 'demo', id: 'pd-m1' }, { error: { code: 'memory_not_found', message: 'Missing', details } }, 404), { code: 'cloud_invalid_response' });
  }
  const operation = { op: 'memory_delete', project: 'demo', id: 'pd-m1', expected: 1 };
  for (const details of [{ memory: { ...entry, project: 'other' }, expected: 1 }, { memory: { ...entry, id: 'pd-m2' }, expected: 1 }, { memory: entry, expected: 2 }]) {
    await assert.rejects(call(operation, { error: { code: 'memory_conflict', message: 'Changed', details } }, 409), { code: 'cloud_invalid_response' });
  }
});
