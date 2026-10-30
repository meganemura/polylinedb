// Asks and checks on local SQLite: the shared flow, the schema 11 upgrade, the move rules as properties, and the snapshot 10 round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as hegel from '@hegeldev/hegel';
import * as gs from '@hegeldev/hegel/generators';
import { node } from 'solarsql/node';
import { initializeStore, openStore, upgradeStore } from '../src/local-store/index.ts';
import { executeOperation, parseOperation, PolylinedbError } from '../src/records/index.ts';
import type { Actor } from '../src/records/index.ts';
import { SCHEMA_SQL, SCHEMA_V11_SQL, canonicalSnapshot, convertSnapshotV9, parseSnapshot } from '../src/records/persistence/persistence.ts';
import type { SqlExecutor } from '../src/records/persistence/persistence.ts';
import { decideItemMove, itemRules, resolvedStatesOf } from '../src/transition/index.ts';
import type { ItemKind, ItemState, ResolvedState } from '../src/transition/index.ts';
import { checkSchema11Upgrade, populateSchema11, runItemsFlow } from './fixtures/items-flow.ts';

const propertyCases = Number(process.env.PD_HEGEL_CASES ?? 100);
assert.ok(Number.isSafeInteger(propertyCases) && propertyCases > 0);

function root(t: test.TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'pd-items-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function freshStore(t: test.TestContext) {
  const location = { directory: join(root(t), 'store') };
  initializeStore(location);
  const store = openStore(location);
  t.after(() => store.close());
  return store;
}

function executor(database: DatabaseSync): SqlExecutor {
  return { reads: node(database), batch: async statements => {
    database.exec('BEGIN IMMEDIATE');
    try { const results = statements.map(({ sql, params }) => ({ rows: database.prepare(sql).all(...params) })); database.exec('COMMIT'); return results; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  } };
}

test('asks, checks, and the close and handoff gate on local SQLite', async t => {
  await runItemsFlow(freshStore(t).db);
});

test('a populated schema 11 store upgrades to schema 13: no items, events keep their seq, and asks follow', async t => {
  const directory = join(root(t), 'populated'); mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, 'polylinedb.sqlite');
  const legacy = new DatabaseSync(path); legacy.exec(SCHEMA_V11_SQL);
  let populated: { id: string }; let before: Record<string, unknown>[];
  try {
    populated = await populateSchema11(executor(legacy));
    before = legacy.prepare('SELECT * FROM change_events ORDER BY seq').all().map(row => ({ ...row }));
  } finally { legacy.close(); }
  chmodSync(path, 0o600);
  assert.throws(() => openStore({ directory }), { code: 'unsupported_schema' }, 'a schema 11 store waits for an explicit upgrade');
  const outcome = upgradeStore({ directory }); assert.deepEqual([outcome.result, outcome.version], ['upgraded', 13]);
  const upgraded = new DatabaseSync(path); const reference = new DatabaseSync(':memory:'); reference.exec(SCHEMA_SQL);
  const schema = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
  try { assert.deepEqual(upgraded.prepare(schema).all(), reference.prepare(schema).all()); } finally { upgraded.close(); reference.close(); }
  const opened = openStore({ directory }); t.after(() => opened.close());
  await checkSchema11Upgrade(opened.db, populated, before);
});

const kinds = ['ask', 'check'] as const;
const states = ['open', 'answered', 'withdrawn', 'met', 'waived'] as const;
const moves = ['answered', 'withdrawn', 'met', 'waived'] as const;

test('property: a move is accepted only by the actors its kind allows, only from open, and an exact repeat is unchanged', async () => {
  await hegel.testAsync(async tc => {
    const kind = tc.draw(gs.sampledFrom([...kinds])) as ItemKind;
    const state = tc.draw(gs.sampledFrom(['open', ...resolvedStatesOf(kind)])) as ItemState;
    const options = kind === 'ask' && tc.draw(gs.booleans()) ? ['left', 'right'] : null;
    const actor: Actor = { id: tc.draw(gs.sampledFrom(['asker', 'other'])), kind: tc.draw(gs.sampledFrom(['human', 'agent'])) };
    const surface = tc.draw(gs.sampledFrom(['operation', 'page'] as const));
    const to = tc.draw(gs.sampledFrom([...moves])) as ResolvedState;
    const answer = tc.draw(gs.sampledFrom([undefined, 'left', 'free text']));
    const note = tc.draw(gs.sampledFrom([undefined, 'because']));
    const resolvedBy = state === 'open' ? null : tc.draw(gs.sampledFrom(['asker', 'other']));
    const stored = { answer: state === 'answered' ? (options?.[0] ?? 'free text') : null, note: state === 'open' ? null : (state === 'answered' ? null : 'because') };
    const item = { kind, state, created_by: 'asker', options, ...stored, resolved_by: resolvedBy };
    const move = { to, ...(answer === undefined ? {} : { answer }), ...(note === undefined ? {} : { note }) };
    const decision = decideItemMove(item, move, actor, surface);
    const allowed = Object.hasOwn(itemRules[kind].moves, to);
    if (!allowed) { assert.deepEqual(decision.accepted ? 'accepted' : decision.rejection.code, 'invalid_input'); return; }
    if (state !== 'open') {
      const exact = state === to && resolvedBy === actor.id && stored.answer === (answer ?? null) && stored.note === (note ?? null);
      assert.deepEqual(decision, exact ? { accepted: true, unchanged: true } : { accepted: false, rejection: { code: 'item_conflict', message: `The ${kind} is already ${state}` } });
      return;
    }
    if (!decision.accepted) return;
    assert.equal(decision.unchanged, false);
    if (to === 'answered') {
      assert.equal(actor.kind, 'human', 'only a human answers');
      assert.ok(actor.id !== 'asker' || surface === 'page', 'the asker answers only on the page');
      assert.ok(answer !== undefined && (options === null || options.includes(answer)), 'the answer is an option when there are options');
    }
    if (to === 'waived') assert.equal(actor.kind, 'human', 'only a human waives');
    if (to === 'withdrawn') assert.ok(actor.kind === 'human' || actor.id === 'asker', 'only the asker or a human withdraws');
    if (to !== 'answered') { assert.equal(answer, undefined); assert.notEqual(note, undefined, 'every move but an answer names its note'); }
  }, { testCases: propertyCases, seed: 20261029, database: hegel.Database.fromPath('.hegel') });
});

test('property: concurrent and repeated moves on one stored ask leave open once and record one event for it', async t => {
  const store = freshStore(t);
  const people: Actor[] = [{ id: 'local:a', kind: 'human' }, { id: 'local:b', kind: 'human' }, { id: 'local:bot', kind: 'agent' }];
  let issue = 0;
  await hegel.testAsync(async tc => {
    const run = (value: unknown, actor: Actor) => executeOperation(store.db, parseOperation(value), actor);
    issue += 1;
    const created = await run({ op: 'create', prefix: 'pr', request_id: crypto.randomUUID(), tool: 'test', project: 'race', body: `Race ${issue}` }, people[0]!);
    assert.ok('issue' in created);
    const id = created.issue.id;
    await run({ op: 'item_add', id, kind: 'ask', text: 'Which?', options: ['left', 'right'], request_id: crypto.randomUUID() }, people[0]!);
    const tries = tc.draw(gs.arrays(gs.record({ actor: gs.integers({ minValue: 0, maxValue: 2 }), to: gs.sampledFrom(['answered', 'withdrawn'] as const), answer: gs.sampledFrom(['left', 'right']) }), { minSize: 1, maxSize: 6 }));
    const outcomes = await Promise.allSettled(tries.map(attempt => run({ op: 'item_resolve', id, n: 1, to: attempt.to,
      ...(attempt.to === 'answered' ? { answer: attempt.answer } : { note: 'dropped' }) }, people[attempt.actor]!)));
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') assert.ok(outcome.reason instanceof PolylinedbError && ['item_conflict', 'item_actor_refused'].includes(outcome.reason.code), String(outcome.reason));
    }
    const rows = await store.db.batch([{ sql: 'SELECT state, answer, resolved_by FROM issue_items WHERE issue_id = ?', params: [id] },
      { sql: "SELECT kind, fields_json FROM change_events WHERE issue_id = ? AND kind IN ('answered','updated') ORDER BY seq", params: [id] }]);
    const item = rows[0]?.rows[0];
    const events = rows[1]?.rows ?? [];
    if (item?.state === 'open') { assert.equal(outcomes.some(outcome => outcome.status === 'fulfilled'), false); assert.equal(events.length, 0); return; }
    assert.equal(events.length, 1, 'one event for the one move out of open');
    assert.equal(events[0]?.kind, item?.state === 'answered' ? 'answered' : 'updated');
    for (const outcome of outcomes) if (outcome.status === 'fulfilled') assert.ok('item' in outcome.value && outcome.value.item.state === item?.state && outcome.value.item.resolved_by === item?.resolved_by);
  }, { testCases: Math.min(propertyCases, 40), seed: 20261030, database: hegel.Database.fromPath('.hegel') });
});

test('snapshot 10 keeps every item through export and import, and a snapshot 9 converts with none', async t => {
  const source = freshStore(t);
  await runItemsFlow(source.db);
  const exported = source.exportSnapshot();
  assert.equal(exported.version, 11);
  assert.equal(exported.issue_items.length, 5);
  assert.ok(exported.issue_items.every(item => typeof item.request_id === 'string'));
  const destination = freshStore(t);
  const imported = destination.importSnapshot(exported);
  assert.equal(imported.issue_items, exported.issue_items.length);
  assert.equal(canonicalSnapshot(destination.exportSnapshot()), canonicalSnapshot(exported));
  const run = (value: unknown) => executeOperation(destination.db, parseOperation(value), 'local:owner');
  const first = exported.issue_items[0]!;
  const shown = await run({ op: 'show', id: first.issue_id });
  assert.ok('items' in shown && Array.isArray(shown.items));
  assert.deepEqual(shown.items[0], (({ issue_id: _, request_id: __, ...item }) => item)(first));

  const [item] = exported.issue_items;
  assert.ok(item);
  for (const broken of [
    { ...item, issue_id: 'zz-404' },
    { ...item, state: 'met' },
    { ...item, kind: 'check', options: ['a', 'b'] },
    { ...item, recommended: 'not an option' },
    { ...item, state: 'open', answer: null, resolved_at: null, resolved_by: null, note: 'a note on an open item' },
  ]) assert.throws(() => parseSnapshot({ ...exported, issue_items: [broken, ...exported.issue_items.slice(1)] }), { code: 'invalid_snapshot' }, JSON.stringify(broken));
  assert.throws(() => parseSnapshot({ ...exported, issue_items: [item, item] }), { code: 'invalid_snapshot' });
  assert.throws(() => parseSnapshot({ ...exported, issue_items: [item, { ...item, n: 99 }] }), { code: 'invalid_snapshot' }, 'a request ID names one item');

  const { issue_items: _items, issue_discoveries: _discoveries, ...rest } = exported;
  const v9 = { ...rest, version: 9 };
  assert.throws(() => parseSnapshot(v9), { code: 'invalid_snapshot' });
  const converted = convertSnapshotV9(v9);
  assert.deepEqual([converted.version, converted.issue_items, converted.issue_discoveries], [11, [], []]);
});
