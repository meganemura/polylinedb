// Compares each transition decision with the real conditional write on one store; callers supply SQLite or D1 and the case count.
// Accept or reject is the independent check, because production also names the rejection with the transition.
// Unexpired leases sit far from their deadlines: statements in one batch can read different seconds, so a near-deadline case has no single expected result.
// A deadline set to the clock at seeding stays expired at every later reading, so that case keeps one expected result.
import assert from 'node:assert/strict';
import * as hegel from '@hegeldev/hegel';
import * as gs from '@hegeldev/hegel/generators';
import { executeOperation, parseOperation, PolylinedbError } from '../../src/records/index.ts';
import { claimRow } from '../../src/records/persistence.ts';
import type { SqlExecutor } from '../../src/records/persistence.ts';
import { decideClaimMutation, decideCreation, decideIssueUpdate, decidePrerequisiteEdit, statuses, issueTypes } from '../../src/transition/index.ts';
import type { ObservedClaim } from '../../src/transition/index.ts';

const owner = 'alice';
const session = '00000000-0000-4000-8000-00000000000a';
const otherIncarnation = 'f'.repeat(32);
const leases = ['none', 'active', 'released', 'expired', 'deadline', 'invalidated', 'foreign'] as const;
const proofs = ['none', 'current', 'wrong_session', 'wrong_generation', 'wrong_incarnation'] as const;
type Lease = typeof leases[number];
type ProofKind = typeof proofs[number];

const coverage = ['accepted', 'conflict', 'claim_required', 'dependency_blocked', 'version_exhausted', 'epic_has_children', 'claim_conflict', 'not_found', 'dependency_conflict', 'dependency_version_exhausted', 'invalid_input'];
const seen = new Set<string>();
const boundaries = ['empty_blockers', 'empty_labels', 'clock_at_deadline'];
const reached = new Set<string>();

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try { await run(); seen.add('accepted'); return 'accepted'; }
  catch (error) { if (error instanceof PolylinedbError) { seen.add(error.code); return error.code; } throw error; }
}

export function differentialCases(db: SqlExecutor, label: string) {
  let sequence = 0;
  const actorRun = (value: unknown, actor = owner) => executeOperation(db, parseOperation(value), actor);
  const sql = async (statement: string, ...params: (string | number | null)[]) => (await db.batch([{ sql: statement, params }]))[0]?.rows ?? [];
  const scope = () => `${label}${++sequence}`;
  const create = async (prefix: string, extra: Record<string, unknown> = {}) => {
    const result = await actorRun({ op: 'create', prefix, request_id: crypto.randomUUID(), tool: 'diff', project: 'diff', body: 'case', ...extra });
    assert.ok('issue' in result); return result.issue;
  };
  const incarnation = async () => String((await sql('SELECT incarnation FROM memory_store_identity WHERE singleton = 1'))[0]?.incarnation);
  const now = async () => Number((await sql('SELECT CAST(unixepoch() AS INTEGER) AS now'))[0]?.now);
  const observedClaim = async (id: string): Promise<ObservedClaim | null> => {
    const row = (await sql('SELECT * FROM issue_claims WHERE issue_id = ?', id))[0];
    return row ? claimRow(row) : null;
  };
  const seedLease = async (id: string, lease: Lease) => {
    if (lease === 'none') return;
    const store = await incarnation();
    const acquired = await actorRun({ op: 'claim_acquire', issue_id: id, incarnation: store, session_id: session, request_id: crypto.randomUUID(), ttl: 300 }, lease === 'foreign' ? 'bob' : owner);
    assert.ok('claim_receipt' in acquired);
    if (lease === 'released') await actorRun({ op: 'claim_release', claim_proof: { issue_id: id, incarnation: store, session_id: session, generation: acquired.claim_receipt.generation }, expected_revision: acquired.claim_receipt.revision, request_id: crypto.randomUUID() });
    if (lease === 'invalidated') await sql('UPDATE issue_claims SET incarnation = ? WHERE issue_id = ?', otherIncarnation, id);
    if (lease === 'expired') await sql('UPDATE issue_claims SET acquired_at = acquired_at - 1000, changed_at = changed_at - 1000, expires_at = acquired_at - 999 WHERE issue_id = ?', id);
    if (lease === 'deadline') await sql('UPDATE issue_claims SET acquired_at = acquired_at - 300, changed_at = changed_at - 300, expires_at = CAST(unixepoch() AS INTEGER) WHERE issue_id = ?', id);
  };
  const observeClock = (claim: ObservedClaim | null, clock: number) => { if (claim?.expires_at === clock) reached.add('clock_at_deadline'); };
  const proofFor = async (id: string, kind: ProofKind) => {
    if (kind === 'none') return undefined;
    const claim = await observedClaim(id);
    return { issue_id: id, incarnation: kind === 'wrong_incarnation' ? otherIncarnation : await incarnation(),
      session_id: kind === 'wrong_session' ? '00000000-0000-4000-8000-00000000000b' : session,
      generation: (claim?.generation ?? 1) + (kind === 'wrong_generation' ? 1 : 0) };
  };

  return {
    update: async (tc: hegel.TestCase) => {
      const prefix = scope();
      const epic = tc.draw(gs.booleans()); const child = epic && tc.draw(gs.booleans());
      const issue = await create(prefix, { type: epic ? 'epic' : tc.draw(gs.sampledFrom(issueTypes.filter(type => type !== 'epic'))), status: tc.draw(gs.sampledFrom(statuses)) });
      if (child) await create(prefix, { parent: issue.id });
      const blocker = tc.draw(gs.sampledFrom(['none', 'open', 'open', 'closed'] as const));
      if (blocker === 'none') reached.add('empty_blockers');
      else {
        const prerequisite = await create(prefix, { status: blocker });
        await actorRun({ op: 'dependency_add', dependent_id: issue.id, blocker_id: prerequisite.id, expected_revision: 1, request_id: crypto.randomUUID() });
      }
      const access = tc.draw(gs.sampledFrom(['open', 'owner', 'random'] as const));
      await seedLease(issue.id, access === 'open' ? 'none' : access === 'owner' ? 'active' : tc.draw(gs.sampledFrom(leases)));
      if (tc.draw(gs.integers({ minValue: 0, maxValue: 4 })) === 0) await sql('UPDATE issues SET priority_v = 9007199254740991 WHERE id = ?', issue.id);
      const actor = access === 'random' ? tc.draw(gs.sampledFrom([owner, 'bob'])) : owner;
      const proof = await proofFor(issue.id, access === 'open' ? 'none' : access === 'owner' ? 'current' : tc.draw(gs.sampledFrom(proofs)));
      const row = (await sql(`SELECT issues.*, EXISTS(SELECT 1 FROM dependencies JOIN issues AS b ON b.id = dependencies.blocker_id WHERE dependencies.dependent_id = issues.id AND b.status <> 'closed') AS blocked,
        EXISTS(SELECT 1 FROM issues AS c WHERE c.parent_id = issues.id) AS parent FROM issues WHERE id = ?`, issue.id))[0];
      assert.ok(row);
      if (row.labels_json === '[]') reached.add('empty_labels');
      const versions = { tool: Number(row.tool_v), project: Number(row.project_v), body: Number(row.body_v), status: Number(row.status_v), type: Number(row.type_v), priority: Number(row.priority_v), labels: Number(row.labels_v) };
      const changes = [];
      for (const field of ['status', 'type', 'body', 'priority'] as const) {
        if (!tc.draw(gs.booleans())) continue;
        const expected = versions[field] + (tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) === 0 ? 1 : 0);
        const value = field === 'status' ? tc.draw(gs.sampledFrom(statuses)) : field === 'type' ? tc.draw(gs.sampledFrom(issueTypes)) : field === 'body' ? 'changed' : tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
        changes.push({ field, value, expected: Math.min(expected, Number.MAX_SAFE_INTEGER) });
      }
      if (changes.length === 0) return;
      const force = changes.some(change => change.field === 'status' && (change.value === 'in_progress' || change.value === 'closed')) && tc.draw(gs.booleans());
      const command = { op: 'update', id: issue.id, changes, ...(force ? { force: true, reason: 'differential' } : {}), ...(proof ? { claim_proof: proof } : {}) };
      const parsed = parseOperation(command);
      assert.ok(parsed.op === 'update');
      const claim = await observedClaim(issue.id); const store = await incarnation(); const clock = await now(); observeClock(claim, clock);
      const decision = decideIssueUpdate({ id: issue.id, versions, has_active_blockers: row.blocked === 1, has_children: row.parent === 1, claim, store_incarnation: store },
        { changes: parsed.changes, force, ...(proof ? { claim_proof: proof } : {}) }, actor, clock);
      assert.equal(await outcome(() => actorRun(command, actor)), decision.accepted ? 'accepted' : decision.rejection.code, JSON.stringify({ command, decision }));
    },
    claim: async (tc: hegel.TestCase) => {
      const issue = await create(scope());
      await seedLease(issue.id, tc.draw(gs.sampledFrom(leases)));
      const actor = tc.draw(gs.sampledFrom([owner, owner, owner, 'bob']));
      const store = await incarnation();
      const claim = await observedClaim(issue.id);
      const op = tc.draw(gs.sampledFrom(['claim_acquire', 'claim_renew', 'claim_release'] as const));
      const command = op === 'claim_acquire'
        ? { op, issue_id: issue.id, incarnation: tc.draw(gs.booleans()) ? store : otherIncarnation, session_id: session, request_id: crypto.randomUUID(), ttl: 300 }
        : { op, claim_proof: await proofFor(issue.id, tc.draw(gs.sampledFrom(proofs.filter(kind => kind !== 'none')))), expected_revision: (claim?.revision ?? 1) + (tc.draw(gs.booleans()) ? 0 : 1), request_id: crypto.randomUUID(), ...(op === 'claim_renew' ? { ttl: 300 } : {}) };
      const parsed = parseOperation(command);
      assert.ok(parsed.op === 'claim_acquire' || parsed.op === 'claim_renew' || parsed.op === 'claim_release');
      const clock = await now(); observeClock(claim, clock);
      const decision = decideClaimMutation(claim, store, parsed, actor, clock);
      assert.equal(await outcome(() => actorRun(command, actor)), decision.accepted ? 'accepted' : 'claim_conflict', JSON.stringify({ command, decision }));
    },
    prerequisite: async (tc: hegel.TestCase) => {
      const prefix = scope();
      const dependent = tc.draw(gs.sampledFrom([true, true, true, false])) ? (await create(prefix)).id : `${prefix}-99`;
      const blocker = tc.draw(gs.sampledFrom([true, true, true, false])) ? (await create(prefix)).id : `${prefix}-98`;
      if (tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) === 0) await sql('UPDATE dependency_revisions SET revision = 9007199254740991 WHERE dependent_id = ?', dependent);
      const current = (await sql('SELECT revision FROM dependency_revisions WHERE dependent_id = ?', dependent))[0];
      const expected = Math.min(Number(current?.revision ?? 1) + (tc.draw(gs.sampledFrom([0, 0, 0, 1]))), Number.MAX_SAFE_INTEGER);
      const decision = decidePrerequisiteEdit({ dependent_revision: current ? Number(current.revision) : null, blocker_exists: (await sql('SELECT 1 FROM issues WHERE id = ?', blocker)).length === 1 }, expected);
      const codes = { dependent_not_found: 'not_found', blocker_not_found: 'not_found', revision_conflict: 'dependency_conflict', revision_exhausted: 'dependency_version_exhausted' } as const;
      const command = { op: 'dependency_add', dependent_id: dependent, blocker_id: blocker, expected_revision: expected, request_id: crypto.randomUUID() };
      assert.equal(await outcome(() => actorRun(command)), decision.accepted ? 'accepted' : codes[decision.reason], JSON.stringify({ command, decision }));
    },
    creation: async (tc: hegel.TestCase) => {
      const prefix = scope();
      const kind = tc.draw(gs.sampledFrom(['none', 'missing', 'epic', 'task'] as const));
      const parent = kind === 'none' ? undefined : kind === 'missing' ? `${prefix}-99` : (await create(prefix, { type: kind })).id;
      const observed = parent === undefined ? null : (await sql('SELECT type FROM issues WHERE id = ?', parent))[0];
      const decision = decideCreation(parent, observed ? { type: issueTypes.find(type => type === observed.type) ?? 'task' } : null);
      const codes = { parent_not_found: 'not_found', parent_not_epic: 'invalid_input' } as const;
      assert.equal(await outcome(() => create(prefix, parent === undefined ? {} : { parent })), decision.accepted ? 'accepted' : codes[decision.reason]);
    },
  };
}

export async function runDifferential(db: SqlExecutor, label: string, testCases: number, seed: number): Promise<void> {
  const cases = differentialCases(db, label);
  seen.clear(); reached.clear();
  for (const check of Object.values(cases)) {
    await hegel.testAsync(async tc => { await check(tc); }, { testCases, seed });
  }
  if (testCases >= 100) assert.deepEqual(coverage.filter(code => !seen.has(code)), [], 'every outcome appeared at least once');
  if (testCases >= 100) assert.deepEqual(boundaries.filter(boundary => !reached.has(boundary)), [], 'every boundary appeared at least once');
}
