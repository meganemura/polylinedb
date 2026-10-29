// Runs asks, checks, the close and handoff gate, and the schema 11 to 12 upgrade on one store; local SQLite and workerd D1 run the same flows.
import assert from 'node:assert/strict';
import { executeOperation, parseOperation } from '../../src/records/index.ts';
import { PolylinedbError } from '../../src/records/store/errors.ts';
import type { Actor, ItemResolve } from '../../src/records/index.ts';
import type { SqlExecutor } from '../../src/records/persistence/persistence.ts';
import { legacyPriority } from './legacy-schema.ts';

type Row = Record<string, unknown>;
type Refusal = { code: string; status: number; details: unknown };

const owner: Actor = { id: 'access:owner', kind: 'human' };
const reviewer: Actor = { id: 'local:reviewer', kind: 'human' };
const agent: Actor = { id: 'service:scout', kind: 'agent' };

function helpers(db: SqlExecutor) {
  const run = async (value: unknown, actor: Actor = owner): Promise<Row> => await executeOperation(db, parseOperation(value), actor) as Row;
  const sql = async (statement: string, ...params: (string | number | null)[]) => ((await db.batch([{ sql: statement, params }]))[0]?.rows ?? []).map(row => ({ ...row }));
  const latest = async () => Number((await sql('SELECT COALESCE(MAX(seq), 0) AS seq FROM change_events'))[0]?.seq);
  const refusal = async (pending: Promise<unknown>): Promise<Refusal> => {
    try { await pending; } catch (error) {
      assert.ok(error instanceof PolylinedbError, String(error));
      return { code: error.code, status: error.status, details: error.details };
    }
    return assert.fail('The write was accepted');
  };
  const events = async (since: number) => {
    const page = await run({ op: 'changes', since: 0, limit: 100 });
    return (page.changes as Row[]).filter(change => Number(change.seq) > since).map(({ issue_id, kind, fields }) => ({ issue_id, kind, fields }));
  };
  const ids = async (op: Row) => {
    const page = await run(op);
    return ((page.issues ?? page.waits) as Row[]).map(row => String((row.issue as Row | undefined)?.id ?? row.id));
  };
  return { run, sql, latest, refusal, events, ids };
}

const create = (body: string, labels = ['ready']) => ({ op: 'create', prefix: 'it', request_id: crypto.randomUUID(), tool: 'test', project: 'items', body, labels });

export async function runItemsFlow(db: SqlExecutor): Promise<void> {
  const { run, latest, refusal, events, ids } = helpers(db);
  const id = ((await run(create('Pick a date format'))).issue as Row & { id: string }).id;
  const ready = { op: 'dependency_worklist', state: 'ready', project: 'items' };
  const waits = { op: 'dependency_owner_waits', project: 'items' };
  assert.deepEqual(await ids(ready), [id]);

  // An agent adds items only under its own claim.
  assert.equal((await refusal(run({ op: 'item_add', id, kind: 'check', text: 'tests pass', request_id: crypto.randomUUID() }, agent))).code, 'claim_required');
  const observed = (await run({ op: 'claim_show', issue_id: id })).claim as Row;
  const acquire = { op: 'claim_acquire', issue_id: id, incarnation: observed.store_incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID() };
  const acquired = await run(acquire, agent);
  assert.deepEqual(acquired.open_asks, []);
  const receipt = acquired.claim_receipt as Row;
  const claim_proof = { issue_id: id, incarnation: receipt.incarnation, session_id: receipt.session_id, generation: receipt.generation };

  const before = await latest();
  const askRequest = { op: 'item_add', id, kind: 'ask', text: 'Bare dates or timestamps?', options: ['bare date', 'timestamp'], recommended: 'bare date', request_id: crypto.randomUUID() };
  const asked = await run(askRequest, agent);
  assert.deepEqual(asked.item, { n: 1, kind: 'ask', text: 'Bare dates or timestamps?', options: ['bare date', 'timestamp'], recommended: 'bare date', state: 'open',
    answer: null, note: null, created_at: (asked.item as Row).created_at, created_by: agent.id, resolved_at: null, resolved_by: null });
  const waitFrom = asked.wait_from as { since: number; incarnation: string };
  assert.equal(waitFrom.since, before + 1, 'the wait starts just after the ask');
  assert.deepEqual(await run(askRequest, agent), { ...asked, wait_from: { ...waitFrom } }, 'a replay returns the same item and writes nothing');
  assert.equal(await latest(), before + 1);
  assert.equal((await refusal(run({ ...askRequest, text: 'Another question' }, agent))).code, 'item_request_conflict');
  assert.equal((await refusal(run({ ...askRequest, request_id: crypto.randomUUID(), options: ['one'] }, agent))).code, 'invalid_input');
  assert.equal((await refusal(run({ ...askRequest, request_id: crypto.randomUUID(), recommended: 'never' }, agent))).code, 'invalid_input');
  const checked = await run({ op: 'item_add', id, kind: 'check', text: 'npm test passes', request_id: crypto.randomUUID() }, agent);
  assert.equal((checked.item as Row).n, 2);
  assert.deepEqual(await events(before), [{ issue_id: id, kind: 'asked', fields: [] }, { issue_id: id, kind: 'updated', fields: ['items'] }]);

  // An open ask takes the issue off ready and puts it on owner waits; a replayed acquisition reads the open ask again.
  assert.deepEqual(await ids(ready), []);
  assert.deepEqual(await ids(waits), [id]);
  const shown = await run({ op: 'show', id });
  assert.deepEqual((shown.items as Row[]).map(item => [item.n, item.kind, item.state]), [[1, 'ask', 'open'], [2, 'check', 'open']]);
  assert.deepEqual((await run(acquire, agent)).open_asks, [{ n: 1, text: 'Bare dates or timestamps?', options: ['bare date', 'timestamp'], recommended: 'bare date' }]);
  // Who answers: never an agent, never the asking actor through an operation, and only with an option.
  const answer = (value: string, actor: Actor, extra: Partial<ItemResolve> = {}) => run({ op: 'item_resolve', id, n: 1, to: 'answered', answer: value, ...extra }, actor);
  assert.deepEqual(await refusal(answer('bare date', agent)), { code: 'item_actor_refused', status: 403, details: { id, n: 1 } });
  assert.equal((await refusal(answer('bare date', { id: agent.id, kind: 'human' }))).code, 'item_actor_refused', 'the asking actor answers only on the page');
  assert.equal((await refusal(answer('epoch', owner))).code, 'invalid_input');
  assert.equal((await refusal(run({ op: 'item_resolve', id, n: 2, to: 'waived', note: 'not needed' }, agent))).code, 'item_actor_refused');
  assert.equal((await refusal(run({ op: 'item_resolve', id, n: 2, to: 'answered', answer: 'yes' }))).code, 'invalid_input');
  assert.equal((await refusal(run({ op: 'item_resolve', id, n: 9, to: 'met', note: 'x' }))).code, 'item_not_found');

  // Close and handoff refuse while items are open, naming each one and its next command.
  const versions = (shown.issue as Row & { versions: { status: number } }).versions;
  const closing = await refusal(run({ op: 'close', id, expected: versions.status, claim_proof }, agent));
  assert.equal(closing.code, 'items_open');
  assert.deepEqual(closing.details, { id, open_items: [{ n: 1, kind: 'ask', text: 'Bare dates or timestamps?' }, { n: 2, kind: 'check', text: 'npm test passes' }] });
  const handoff = { op: 'claim_handoff', claim_proof, expected_revision: 1, request_id: crypto.randomUUID(), tip: 'abcdef0' };
  assert.equal((await refusal(run(handoff, agent))).code, 'items_open');
  assert.equal(((await run({ op: 'claim_show', issue_id: id })).claim as Row).state, 'active', 'the refused handoff keeps the claim');

  // Two different answers race: exactly one lands, the other sees the answer that stands.
  const sinceAnswer = await latest();
  const raced = await Promise.allSettled([answer('bare date', owner, { note: 'keep it simple' }), answer('timestamp', reviewer)]);
  const landed = raced.filter(outcome => outcome.status === 'fulfilled');
  assert.equal(landed.length, 1);
  const lost = raced.find(outcome => outcome.status === 'rejected');
  assert.ok(lost && lost.status === 'rejected' && lost.reason instanceof PolylinedbError && lost.reason.code === 'item_conflict');
  const standing = (lost.reason.details as { item: Row }).item;
  const winner = standing.answer === 'bare date' ? owner : reviewer;
  assert.equal(standing.resolved_by, winner.id);
  // A check does not hold ready, so the answer to the only ask makes the open, unblocked issue ready again.
  assert.deepEqual(await events(sinceAnswer), [{ issue_id: id, kind: 'answered', fields: [] }, { issue_id: id, kind: 'became_ready', fields: [] }]);
  const repeat = winner === owner ? await answer('bare date', owner, { note: 'keep it simple' }) : await answer('timestamp', reviewer);
  assert.equal((repeat.item as Row).state, 'answered');
  assert.equal(await latest(), sinceAnswer + 2, 'a repeated answer writes nothing');
  assert.deepEqual(await ids(ready), [id]);
  assert.deepEqual(await ids(waits), []);

  // A check is met with evidence by the agent, after which the handoff goes through.
  assert.equal((await refusal(run({ op: 'item_resolve', id, n: 2, to: 'met' }, agent))).code, 'invalid_input');
  await run({ op: 'item_resolve', id, n: 2, to: 'met', note: 'npm test: 12 pass, 0 fail' }, agent);
  const handed = await run({ ...handoff, request_id: crypto.randomUUID() }, agent);
  assert.ok(handed.handoff);

  // Force closes past an open item the way it closes past prerequisites, and records the reason.
  const forced = ((await run(create('Forced close'))).issue as Row & { id: string; versions: { status: number } });
  await run({ op: 'item_add', id: forced.id, kind: 'check', text: 'a check nobody meets', request_id: crypto.randomUUID() });
  assert.equal((await refusal(run({ op: 'close', id: forced.id, expected: forced.versions.status }))).code, 'items_open');
  const closed = await run({ op: 'close', id: forced.id, expected: forced.versions.status, force: true, reason: 'superseded by another issue' });
  assert.equal((closed.issue as Row).status, 'closed');
  assert.equal((await refusal(run({ op: 'item_add', id: forced.id, kind: 'check', text: 'too late', request_id: crypto.randomUUID() }))).code, 'conflict');

  // The last open ask on an open, unblocked issue records became_ready after the answer; a withdrawal needs a reason.
  const plain = ((await run(create('Ask and withdraw'))).issue as Row & { id: string }).id;
  await run({ op: 'item_add', id: plain, kind: 'ask', text: 'Free answer?', request_id: crypto.randomUUID() });
  await run({ op: 'item_add', id: plain, kind: 'ask', text: 'Second question?', request_id: crypto.randomUUID() });
  const sinceWithdraw = await latest();
  assert.equal((await refusal(run({ op: 'item_resolve', id: plain, n: 2, to: 'withdrawn' }))).code, 'invalid_input');
  assert.equal((await refusal(run({ op: 'item_resolve', id: plain, n: 2, to: 'withdrawn', note: 'not mine' }, agent))).code, 'item_actor_refused');
  await run({ op: 'item_resolve', id: plain, n: 2, to: 'withdrawn', note: 'answered in the issue text' });
  await run({ op: 'item_resolve', id: plain, n: 1, to: 'answered', answer: 'any free text' }, reviewer);
  assert.deepEqual(await events(sinceWithdraw), [
    { issue_id: plain, kind: 'updated', fields: ['items'] },
    { issue_id: plain, kind: 'answered', fields: [] },
    { issue_id: plain, kind: 'became_ready', fields: [] },
  ]);
  assert.deepEqual(await ids(ready), [id, plain], 'a handed-off issue is open with main-wait, which is no owner wait');
}

/** Writes rows and change events into a schema 11 store, so the upgrade has events that a reader's cursor already holds. */
export async function populateSchema11(db: SqlExecutor): Promise<{ id: string }> {
  const { run } = helpers(db);
  const id = ((await run(create('Before items'))).issue as Row & { id: string }).id;
  await legacyPriority(db, { id, priority: 1, actor: owner.id });
  return { id };
}

/** Checks a store that upgraded from schema 11 after populateSchema11: no items, events keep their seq, and asks continue after them. */
export async function checkSchema11Upgrade(db: SqlExecutor, populated: { id: string }, before: Row[]): Promise<void> {
  const { run, sql, latest } = helpers(db);
  assert.equal(before.length, 2);
  assert.deepEqual(await sql('SELECT * FROM change_events ORDER BY seq'), before, 'the rebuild keeps every event with its seq');
  assert.deepEqual(await sql('SELECT version FROM schema_version'), [{ version: 12 }]);
  assert.deepEqual(await sql('SELECT * FROM issue_items'), []);
  assert.deepEqual((await run({ op: 'show', id: populated.id })).items, []);
  const last = await latest();
  await run({ op: 'item_add', id: populated.id, kind: 'ask', text: 'After the upgrade?', request_id: crypto.randomUUID() });
  await run({ op: 'item_resolve', id: populated.id, n: 1, to: 'answered', answer: 'yes' }, reviewer);
  const page = await run({ op: 'changes', since: last, incarnation: (await run({ op: 'changes', since: 0, limit: 1 })).incarnation, kinds: ['asked', 'answered', 'became_ready'] });
  assert.deepEqual((page.changes as Row[]).map(({ seq, kind }) => ({ seq, kind })), [{ seq: last + 1, kind: 'asked' }, { seq: last + 2, kind: 'answered' }, { seq: last + 3, kind: 'became_ready' }]);
}
