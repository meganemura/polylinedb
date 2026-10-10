// Checks claim, readiness, and containment decisions against rules read from the documentation instead of the transition code.
// Expected values come from abstract world labels and the cited sentence; the transition and SQLite only supply actual values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeStore, openStore } from '../src/local-store/index.ts';
import { executeOperation, parseOperation } from '../src/records/index.ts';
import { admitAgentWrite, claimState, decideClaimMutation, decideIssueUpdate, statuses } from '../src/transition/index.ts';
import type { Actor, ClaimProof, FieldChange, ObservedClaim, Status } from '../src/transition/index.ts';

const store = 'a'.repeat(32);
const formerStore = 'b'.repeat(32);
const holder = 'alice';
const stranger = 'bob';
const session = '00000000-0000-4000-8000-000000000001';
const otherSession = '00000000-0000-4000-8000-000000000002';
const generation = 3;
const revision = 7;
const deadline = 1000;

const leases = ['never_claimed', 'held', 'released', 'invalidated'] as const;
const clocks = ['before', 'equal', 'after'] as const;
const proofFields = ['issue', 'incarnation', 'session', 'generation'] as const;
const callers = ['holder', 'stranger'] as const;
type Lease = typeof leases[number];
type Clock = typeof clocks[number];
type ProofField = typeof proofFields[number];
type Caller = typeof callers[number];
type Proof = { supplied: false } | { supplied: true; differs: ReadonlySet<ProofField> };
type SpecState = 'never_claimed' | 'active' | 'released' | 'expired' | 'invalidated';

const clockValue: Record<Clock, number> = { before: deadline - 1, equal: deadline, after: deadline + 1 };
const differingProofs: ReadonlySet<ProofField>[] = Array.from({ length: 2 ** proofFields.length },
  (_, mask) => new Set(proofFields.filter((_, bit) => (mask >> bit) & 1)));
const proofs: Proof[] = [{ supplied: false }, ...differingProofs.map(differs => ({ supplied: true as const, differs }))];
const actorId = (caller: Caller) => caller === 'holder' ? holder : stranger;

function observedClaim(lease: Lease): ObservedClaim | null {
  if (lease === 'never_claimed') return null;
  return { incarnation: lease === 'invalidated' ? formerStore : store, actor: holder, session_id: session, generation, revision,
    expires_at: deadline, released_at: lease === 'released' ? deadline - 10 : null };
}

function concreteProof(lease: Lease, differs: ReadonlySet<ProofField>): ClaimProof {
  const retained = lease === 'invalidated' ? formerStore : store;
  return {
    issue_id: differs.has('issue') ? 'pd-2' : 'pd-1',
    incarnation: differs.has('incarnation') ? (retained === store ? formerStore : store) : retained,
    session_id: differs.has('session') ? otherSession : session,
    generation: differs.has('generation') ? generation + 1 : generation,
  };
}

// docs/claims.md "Acquire and inspect": states are never_claimed, active, released, expired, and invalidated;
// an invalidated lease belongs to another store incarnation. "Renew, release, and retry": equality means expiry.
// The released lease in this domain ended before its deadline, so release is the event that ended it.
function specState(lease: Lease, clock: Clock): SpecState {
  if (lease === 'never_claimed' || lease === 'invalidated' || lease === 'released') return lease;
  return clock === 'before' ? 'active' : 'expired';
}

// docs/claims.md "Change status with a proof": the database checks the authenticated actor, session, generation,
// issue, incarnation, and expiry in the same write as field CAS.
function currentProof(world: { lease: Lease; clock: Clock; proof: Proof; caller: Caller }): boolean {
  return world.proof.supplied && world.proof.differs.size === 0 && world.caller === 'holder' && specState(world.lease, world.clock) === 'active';
}

const changes: readonly FieldChange[] = [
  { field: 'status', expected: 1, value: 'open' },
  { field: 'status', expected: 1, value: 'in_progress' },
  { field: 'status', expected: 1, value: 'closed' },
  { field: 'body', expected: 1, value: 'edited' },
  { field: 'type', expected: 1, value: 'task' },
  { field: 'type', expected: 1, value: 'epic' },
];
type UpdateWorld = { lease: Lease; clock: Clock; proof: Proof; caller: Caller; change: FieldChange; blockers: boolean; children: boolean; force: boolean };
type Rule<World> = { code: string; source: string; violated: (world: World) => boolean };

const updateRules: Rule<UpdateWorld>[] = [
  { code: 'claim_required', source: "docs/claims.md \"Change status with a proof\": After acquisition has activated an issue's claim lifecycle, every requested status write requires an unexpired current proof.",
    violated: world => world.change.field === 'status' && world.lease !== 'never_claimed' && !currentProof(world) },
  { code: 'claim_required', source: 'docs/adr/0009-issue-ownership.md: An explicitly supplied proof also guards edits to other fields.',
    violated: world => world.proof.supplied && !currentProof(world) },
  { code: 'dependency_blocked', source: 'docs/prerequisites.md: A requested start or close requires resolved prerequisites. An explicit exception requires `--force --reason TEXT`.',
    violated: world => world.change.field === 'status' && (world.change.value === 'in_progress' || world.change.value === 'closed') && world.blockers && !world.force },
  { code: 'epic_has_children', source: 'docs/architecture.md "Containment and queries": A parent with children must remain an epic.',
    violated: world => world.children && world.change.field === 'type' && world.change.value !== 'epic' },
];

function* updateWorlds(): Generator<UpdateWorld> {
  for (const lease of leases) for (const clock of clocks) for (const proof of proofs) for (const caller of callers)
    for (const change of changes) for (const blockers of [false, true]) for (const children of [false, true]) for (const force of [false, true])
      yield { lease, clock, proof, caller, change, blockers, children, force };
}
const updateDomainSize = leases.length * clocks.length * proofs.length * callers.length * changes.length * 2 * 2 * 2;

function decideUpdate(world: UpdateWorld) {
  const versions = { tool: 1, project: 1, body: 1, status: 1, type: 1, priority: 1, labels: 1 };
  return decideIssueUpdate(
    { id: 'pd-1', versions, has_active_blockers: world.blockers, has_children: world.children, claim: observedClaim(world.lease), store_incarnation: store },
    { changes: [world.change], force: world.force, ...(world.proof.supplied ? { claim_proof: concreteProof(world.lease, world.proof.differs) } : {}) },
    actorId(world.caller), clockValue[world.clock]);
}

function describe(world: object): string {
  return JSON.stringify(world, (_, value: unknown) => value instanceof Set ? [...value] : value);
}

type ClaimWorld =
  | { op: 'claim_acquire'; lease: Lease; clock: Clock; caller: Caller; incarnation: 'current' | 'former' }
  | { op: 'claim_renew' | 'claim_release'; lease: Lease; clock: Clock; caller: Caller; differs: ReadonlySet<ProofField>; revision: 'observed' | 'stale' };

const claimRules: Rule<ClaimWorld>[] = [
  { code: 'claim_conflict', source: 'docs/adr/0009-issue-ownership.md: The database accepts acquisition only when that incarnation matches the current singleton and the issue has no active claim.',
    violated: world => world.op === 'claim_acquire' && (world.incarnation !== 'current' || specState(world.lease, world.clock) === 'active') },
  { code: 'claim_conflict', source: 'docs/adr/0009-issue-ownership.md: Renewal and release increase revision and require the observed revision and a current ownership proof.',
    violated: world => world.op !== 'claim_acquire' && (world.revision !== 'observed' || !currentProof({ ...world, proof: { supplied: true, differs: world.differs } })) },
];

// Renewal and release name their issue only through the proof, so a proof for another issue addresses that issue's claim.
const leaseProofs = differingProofs.filter(differs => !differs.has('issue'));

function* claimWorlds(): Generator<ClaimWorld> {
  for (const lease of leases) for (const clock of clocks) for (const caller of callers) {
    for (const incarnation of ['current', 'former'] as const) yield { op: 'claim_acquire', lease, clock, caller, incarnation };
    for (const op of ['claim_renew', 'claim_release'] as const) for (const differs of leaseProofs)
      for (const observed of ['observed', 'stale'] as const) yield { op, lease, clock, caller, differs, revision: observed };
  }
}
const claimDomainSize = leases.length * clocks.length * callers.length * (2 + 2 * leaseProofs.length * 2);

function decideClaim(world: ClaimWorld) {
  const command = world.op === 'claim_acquire'
    ? { op: world.op, incarnation: world.incarnation === 'current' ? store : formerStore }
    : { op: world.op, claim_proof: concreteProof(world.lease, world.differs), expected_revision: world.revision === 'observed' ? revision : revision + 1 };
  return decideClaimMutation(observedClaim(world.lease), store, command, actorId(world.caller), clockValue[world.clock]);
}

const labelSets: readonly (readonly string[])[] = [[], ['ready'], ['main-lock'], ['main-lock', 'ready']];
type GateWorld = { kind: Actor['kind']; write: 'claim_acquire' | 'issue_write'; labels: readonly string[]; lease: Lease; clock: Clock; caller: Caller };
const gateRules: Rule<GateWorld>[] = [
  { code: 'not_ready', source: 'docs/claims.md "Gate agent work": An agent claims only an issue with the `ready` label.',
    violated: world => world.kind === 'agent' && world.write === 'claim_acquire' && !world.labels.includes('ready') },
  { code: 'claim_required', source: 'docs/claims.md "Gate agent work": An agent needs its own active claim before it changes an issue. The actor identifies the holder.',
    violated: world => world.kind === 'agent' && world.write === 'issue_write' && !(world.caller === 'holder' && specState(world.lease, world.clock) === 'active') },
];

function* gateWorlds(): Generator<GateWorld> {
  for (const kind of ['human', 'agent'] as const) for (const write of ['claim_acquire', 'issue_write'] as const) for (const labels of labelSets)
    for (const lease of leases) for (const clock of clocks) for (const caller of callers) yield { kind, write, labels, lease, clock, caller };
}
const gateDomainSize = 2 * 2 * labelSets.length * leases.length * clocks.length * callers.length;

function decideGate(world: GateWorld) {
  return admitAgentWrite({ id: actorId(world.caller), kind: world.kind }, world.write,
    { labels: world.labels, claim: observedClaim(world.lease), store_incarnation: store, now: clockValue[world.clock] });
}

function expectRules<World extends object>(world: World, rules: Rule<World>[], accepted: boolean, code: string | undefined): void {
  const violated = rules.filter(rule => rule.violated(world));
  const context = `${describe(world)}\n${violated.map(rule => rule.source).join('\n') || 'no documented rule rejects this combination'}`;
  assert.equal(accepted, violated.length === 0, context);
  if (!accepted && code !== undefined) assert.ok(violated.some(rule => rule.code === code), `${code} is not among the documented rejections\n${context}`);
}

test('property: every bounded claim, proof, and clock combination follows the documented rules', t => {
  let checked = 0;
  for (const lease of leases) for (const clock of clocks) {
    assert.equal(claimState(observedClaim(lease), store, clockValue[clock]), specState(lease, clock), describe({ lease, clock }));
    checked += 1;
  }
  for (const world of updateWorlds()) {
    const decision = decideUpdate(world);
    expectRules(world, updateRules, decision.accepted, decision.accepted ? undefined : decision.rejection.code);
    checked += 1;
  }
  for (const world of claimWorlds()) {
    expectRules(world, claimRules, decideClaim(world).accepted, undefined);
    checked += 1;
  }
  for (const world of gateWorlds()) {
    const decision = decideGate(world);
    expectRules(world, gateRules, decision.admitted, decision.admitted ? undefined : decision.code);
    checked += 1;
  }
  const expected = leases.length * clocks.length + updateDomainSize + claimDomainSize + gateDomainSize;
  assert.equal(checked, expected);
  t.diagnostic(`checked ${checked} combinations: claim state ${leases.length * clocks.length}, issue update ${updateDomainSize}, claim mutation ${claimDomainSize}, agent gate ${gateDomainSize}`);
});

// docs/claims.md "Renew, release, and retry": The database clock determines the deadline; equality means expiry.
test('property: a proof whose deadline equals the clock cannot change the status (docs/claims.md: equality means expiry)', () => {
  let matchingProofs = 0;
  for (const world of updateWorlds()) {
    if (world.clock !== 'equal' || world.lease === 'never_claimed' || world.change.field !== 'status') continue;
    assert.equal(decideUpdate(world).accepted, false, describe(world));
    if (world.lease === 'held' && world.caller === 'holder' && world.proof.supplied && world.proof.differs.size === 0) matchingProofs += 1;
  }
  for (const world of claimWorlds()) {
    if (world.clock !== 'equal' || world.op === 'claim_acquire') continue;
    assert.equal(decideClaim(world).accepted, false, describe(world));
  }
  assert.ok(matchingProofs > 0);
});

// docs/claims.md "Change status with a proof": After acquisition has activated an issue's claim lifecycle, every requested
// status write requires an unexpired current proof. docs/adr/0009-issue-ownership.md: The prerequisite force option does not bypass ownership.
test('property: only the holder of the current proof changes the status of a claimed issue (docs/claims.md: Change status with a proof)', () => {
  let accepted = 0;
  for (const world of updateWorlds()) {
    if (world.lease === 'never_claimed' || world.change.field !== 'status' || !decideUpdate(world).accepted) continue;
    assert.ok(world.caller === 'holder' && world.proof.supplied && world.proof.differs.size === 0 && world.lease === 'held' && world.clock === 'before', describe(world));
    accepted += 1;
  }
  assert.ok(accepted > 0);
});

// docs/architecture.md "Containment and queries": A parent with children must remain an epic.
test('property: an epic with children stays an epic (docs/architecture.md: Containment and queries)', () => {
  let demotions = 0;
  for (const world of updateWorlds()) {
    if (!world.children || world.change.field !== 'type' || world.change.value === 'epic') continue;
    assert.equal(decideUpdate(world).accepted, false, describe(world));
    demotions += 1;
  }
  assert.ok(demotions > 0);
});

// docs/prerequisites.md: Ready issues have status `open`, no active blockers, and no `main-lock` label.
// Blocked issues have status `open`, `in_progress`, or `deferred`, with an active blocker. A blocker is active when its status differs from `closed`.
// CONTEXT.md: A ready issue is an `open` issue with no active blockers. docs/claims.md "Gate agent work": `pd ready` shows an agent only labeled issues.
test('property: an issue is ready only when it is open and every blocker is closed (docs/prerequisites.md; CONTEXT.md: Ready issue)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pd-spec-ready-'));
  const cwd = join(root, 'work'); const directory = join(root, 'store'); mkdirSync(cwd);
  initializeStore({ directory, cwd }); const local = openStore({ directory, cwd });
  t.after(() => { local.close(); rmSync(root, { recursive: true, force: true }); });
  const human = 'spec-human'; const agent: Actor = { id: 'spec-agent', kind: 'agent' };
  const run = (value: unknown, actor: string | Actor = human) => executeOperation(local.db, parseOperation(value), actor);
  const create = async (project: string, status: Status, labels: readonly string[]) => {
    const result = await run({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'spec', project, body: 'spec', status, labels });
    assert.ok('issue' in result); return result.issue.id;
  };
  const blockerPool = new Map<Status, string[]>();
  for (const status of statuses) blockerPool.set(status, [await create('spec-blockers', status, []), await create('spec-blockers', status, [])]);
  const blockerSets: Status[][] = [[]];
  for (const [index, first] of statuses.entries()) {
    blockerSets.push([first]);
    for (const second of statuses.slice(index)) blockerSets.push([first, second]);
  }
  const expected = { ready: new Set<string>(), agentReady: new Set<string>(), blocked: new Set<string>() };
  let dependents = 0;
  for (const status of statuses) for (const blockers of blockerSets) for (const labels of labelSets) {
    const id = await create('spec-dependents', status, labels);
    for (const [index, blocker] of blockers.entries()) {
      const blockerId = blockerPool.get(blocker)?.[index]; assert.ok(blockerId);
      await run({ op: 'dependency_add', dependent_id: id, blocker_id: blockerId, expected_revision: index + 1, request_id: crypto.randomUUID() });
    }
    const active = blockers.some(blocker => blocker !== 'closed');
    if (status === 'open' && !active && !labels.includes('main-lock')) expected.ready.add(id);
    if (status === 'open' && !active && !labels.includes('main-lock') && labels.includes('ready')) expected.agentReady.add(id);
    if (status !== 'closed' && active) expected.blocked.add(id);
    dependents += 1;
  }
  const worklist = async (state: 'ready' | 'blocked', actor: string | Actor) => {
    const ids = new Set<string>(); let after: string | null = null;
    do {
      const page = await run({ op: 'dependency_worklist', state, project: 'spec-dependents', limit: 100, ...(after ? { after } : {}) }, actor);
      assert.ok('issues' in page && 'next_cursor' in page);
      for (const issue of page.issues) ids.add(issue.id);
      after = page.next_cursor;
    } while (after !== null);
    return ids;
  };
  assert.deepEqual(await worklist('ready', human), expected.ready);
  assert.deepEqual(await worklist('ready', agent), expected.agentReady);
  assert.deepEqual(await worklist('blocked', human), expected.blocked);
  assert.equal(dependents, statuses.length * blockerSets.length * labelSets.length);
  t.diagnostic(`checked ${dependents} dependents against the ready, agent ready, and blocked worklists`);
});
