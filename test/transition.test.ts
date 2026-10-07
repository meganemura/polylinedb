// Checks the pure transition decisions with literal states; store tests prove that SQL agrees with them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { claimState, decideClaimMutation, decideCreation, decideIssueUpdate, decidePrerequisiteEdit, decideReplay } from '../src/transition/index.ts';
import type { ObservedClaim, ObservedIssue } from '../src/transition/index.ts';

const store = 'a'.repeat(32);
const session = '00000000-0000-4000-8000-000000000001';
const proof = { issue_id: 'pd-1', incarnation: store, session_id: session, generation: 2 };
const lease = (overrides: Partial<ObservedClaim> = {}): ObservedClaim => ({
  incarnation: store, actor: 'alice', session_id: session, generation: 2, revision: 5, expires_at: 1000, released_at: null, ...overrides,
});
const versions = { tool: 1, project: 1, body: 3, status: 4, type: 1, priority: 1, labels: 1 };
const issue = (overrides: Partial<ObservedIssue> = {}): ObservedIssue => ({
  id: 'pd-1', versions, has_active_blockers: false, has_children: false, claim: null, store_incarnation: store, ...overrides,
});
const close = { field: 'status', expected: 4, value: 'closed' } as const;

test('claim state follows incarnation, release, and the deadline', () => {
  assert.equal(claimState(null, store, 999), 'never_claimed');
  assert.equal(claimState(lease({ incarnation: 'b'.repeat(32) }), store, 999), 'invalidated');
  assert.equal(claimState(lease({ released_at: 900 }), store, 999), 'released');
  assert.equal(claimState(lease(), store, 999), 'active');
  assert.equal(claimState(lease(), store, 1000), 'expired');
});

test('an update with matching versions and no guards commits', () => {
  assert.deepEqual(decideIssueUpdate(issue(), { changes: [{ field: 'body', expected: 3, value: 'new' }], force: false }, 'alice', 999), { accepted: true });
});

test('stale versions report every conflicting field before other rules', () => {
  const decision = decideIssueUpdate(issue({ claim: lease(), has_active_blockers: true }),
    { changes: [close, { field: 'body', expected: 2, value: 'x' }, { field: 'priority', expected: 1, value: 0 }], force: false }, 'alice', 999);
  assert.deepEqual(decision, { accepted: false, rejection: { code: 'conflict', fields: [{ field: 'body', expected: 2, actual: 3 }] } });
});

test('a status write needs a proof once the claim lifecycle starts', () => {
  assert.deepEqual(decideIssueUpdate(issue(), { changes: [close], force: false }, 'alice', 999), { accepted: true });
  assert.deepEqual(decideIssueUpdate(issue({ claim: lease({ released_at: 10 }) }), { changes: [close], force: false }, 'alice', 999),
    { accepted: false, rejection: { code: 'claim_required' } });
  assert.deepEqual(decideIssueUpdate(issue({ claim: lease() }), { changes: [{ field: 'body', expected: 3, value: 'x' }], force: false }, 'alice', 999), { accepted: true });
});

test('a proof must match the actor, session, generation, incarnation, and deadline', () => {
  const update = { changes: [close], force: false, claim_proof: proof };
  assert.deepEqual(decideIssueUpdate(issue({ claim: lease() }), update, 'alice', 999), { accepted: true });
  const required = { accepted: false, rejection: { code: 'claim_required' } };
  assert.deepEqual(decideIssueUpdate(issue({ claim: lease() }), update, 'bob', 999), required);
  assert.deepEqual(decideIssueUpdate(issue({ claim: lease() }), update, 'alice', 1000), required);
  assert.deepEqual(decideIssueUpdate(issue({ claim: lease({ generation: 3 }) }), update, 'alice', 999), required);
  assert.deepEqual(decideIssueUpdate(issue({ claim: lease(), store_incarnation: 'b'.repeat(32) }), update, 'alice', 999), required);
  assert.deepEqual(decideIssueUpdate(issue({ claim: lease(), id: 'pd-2' }), update, 'alice', 999), required);
  assert.deepEqual(decideIssueUpdate(issue(), { changes: [{ field: 'body', expected: 3, value: 'x' }], force: false, claim_proof: proof }, 'alice', 999), required);
});

test('start and close need resolved blockers unless forced', () => {
  const blocked = issue({ has_active_blockers: true });
  assert.deepEqual(decideIssueUpdate(blocked, { changes: [close], force: false }, 'alice', 999), { accepted: false, rejection: { code: 'dependency_blocked' } });
  assert.deepEqual(decideIssueUpdate(blocked, { changes: [{ field: 'status', expected: 4, value: 'in_progress' }], force: false }, 'alice', 999),
    { accepted: false, rejection: { code: 'dependency_blocked' } });
  assert.deepEqual(decideIssueUpdate(blocked, { changes: [{ field: 'status', expected: 4, value: 'open' }], force: false }, 'alice', 999), { accepted: true });
  assert.deepEqual(decideIssueUpdate(blocked, { changes: [close], force: true }, 'alice', 999), { accepted: true });
});

test('an exhausted version and an epic with children reject the update', () => {
  const full = issue({ versions: { ...versions, priority: Number.MAX_SAFE_INTEGER } });
  assert.deepEqual(decideIssueUpdate(full, { changes: [{ field: 'priority', expected: Number.MAX_SAFE_INTEGER, value: 0 }], force: false }, 'alice', 999),
    { accepted: false, rejection: { code: 'version_exhausted', field: 'priority' } });
  const parent = issue({ has_children: true });
  assert.deepEqual(decideIssueUpdate(parent, { changes: [{ field: 'type', expected: 1, value: 'task' }], force: false }, 'alice', 999),
    { accepted: false, rejection: { code: 'epic_has_children' } });
  assert.deepEqual(decideIssueUpdate(parent, { changes: [{ field: 'type', expected: 1, value: 'epic' }], force: false }, 'alice', 999), { accepted: true });
});

test('claim acquisition needs the current incarnation and no active lease', () => {
  const acquire = { op: 'claim_acquire', incarnation: store } as const;
  assert.deepEqual(decideClaimMutation(null, store, acquire, 'alice', 999), { accepted: true });
  assert.deepEqual(decideClaimMutation(lease(), store, acquire, 'bob', 1000), { accepted: true });
  assert.deepEqual(decideClaimMutation(lease(), store, acquire, 'bob', 999), { accepted: false, reason: 'already_active' });
  assert.deepEqual(decideClaimMutation(null, store, { op: 'claim_acquire', incarnation: 'b'.repeat(32) }, 'alice', 999), { accepted: false, reason: 'stale_incarnation' });
  assert.deepEqual(decideClaimMutation(lease({ released_at: 1, generation: Number.MAX_SAFE_INTEGER }), store, acquire, 'alice', 999), { accepted: false, reason: 'counter_exhausted' });
});

test('claim renewal and release need the observed revision and a current proof', () => {
  const renew = { op: 'claim_renew', claim_proof: proof, expected_revision: 5 } as const;
  assert.deepEqual(decideClaimMutation(lease(), store, renew, 'alice', 999), { accepted: true });
  assert.deepEqual(decideClaimMutation(lease(), store, { ...renew, op: 'claim_release' }, 'alice', 999), { accepted: true });
  assert.deepEqual(decideClaimMutation(lease(), store, { ...renew, expected_revision: 4 }, 'alice', 999), { accepted: false, reason: 'revision_conflict' });
  assert.deepEqual(decideClaimMutation(null, store, renew, 'alice', 999), { accepted: false, reason: 'revision_conflict' });
  assert.deepEqual(decideClaimMutation(lease(), store, renew, 'alice', 1000), { accepted: false, reason: 'proof_rejected' });
  assert.deepEqual(decideClaimMutation(lease({ revision: Number.MAX_SAFE_INTEGER }), store, { ...renew, expected_revision: Number.MAX_SAFE_INTEGER }, 'alice', 999),
    { accepted: false, reason: 'counter_exhausted' });
});

test('a repeated request ID replays only for the same actor and payload', () => {
  assert.equal(decideReplay({ actor: 'alice', payload: '{"a":1}' }, 'alice', '{"a":1}'), 'replay');
  assert.equal(decideReplay({ actor: 'alice', payload: '{"a":1}' }, 'bob', '{"a":1}'), 'request_conflict');
  assert.equal(decideReplay({ actor: 'alice', payload: '{"a":1}' }, 'alice', '{"a":2}'), 'request_conflict');
});

test('a child needs an existing epic parent', () => {
  assert.deepEqual(decideCreation(undefined, null), { accepted: true });
  assert.deepEqual(decideCreation('pd-1', { type: 'epic' }), { accepted: true });
  assert.deepEqual(decideCreation('pd-1', null), { accepted: false, reason: 'parent_not_found' });
  assert.deepEqual(decideCreation('pd-1', { type: 'task' }), { accepted: false, reason: 'parent_not_epic' });
});

test('a prerequisite edit needs both endpoints and the observed revision', () => {
  assert.deepEqual(decidePrerequisiteEdit({ dependent_revision: 3, blocker_exists: true }, 3), { accepted: true });
  assert.deepEqual(decidePrerequisiteEdit({ dependent_revision: null, blocker_exists: false }, 3), { accepted: false, reason: 'dependent_not_found' });
  assert.deepEqual(decidePrerequisiteEdit({ dependent_revision: 3, blocker_exists: false }, 3), { accepted: false, reason: 'blocker_not_found' });
  assert.deepEqual(decidePrerequisiteEdit({ dependent_revision: 4, blocker_exists: true }, 3), { accepted: false, reason: 'revision_conflict' });
  assert.deepEqual(decidePrerequisiteEdit({ dependent_revision: Number.MAX_SAFE_INTEGER, blocker_exists: true }, Number.MAX_SAFE_INTEGER), { accepted: false, reason: 'revision_exhausted' });
});
