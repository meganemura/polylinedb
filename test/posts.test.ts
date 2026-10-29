// Exercises posts, replies, and stars on real local stores; test/posts-d1.integration.ts runs the same flows on workerd D1.
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
import { executeOperation, parseOperation } from '../src/records/index.ts';
import { SCHEMA_SQL, SCHEMA_V10_SQL, canonicalSnapshot, convertSnapshotV8, parseSnapshot } from '../src/records/persistence/persistence.ts';
import type { SqlExecutor } from '../src/records/persistence/persistence.ts';
import { PolylinedbError } from '../src/records/store/errors.ts';
import { checkSchema10Upgrade, populateSchema10, readEvents, runPostsFlow, runTimelineFlow } from './fixtures/posts-flow.ts';

const propertyCases = Number(process.env.PD_HEGEL_CASES ?? 100);
assert.ok(Number.isSafeInteger(propertyCases) && propertyCases > 0);

function root(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'pd-posts-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function executor(db: DatabaseSync): SqlExecutor {
  return { reads: node(db), async batch(statements) {
    db.exec('BEGIN IMMEDIATE');
    try { const rows = statements.map(statement => ({ rows: db.prepare(statement.sql).all(...statement.params) })); db.exec('COMMIT'); return rows; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
}
function store(t: test.TestContext) {
  const directory = join(root(t), 'store'); initializeStore({ directory });
  const opened = openStore({ directory }); t.after(() => opened.close());
  return opened;
}

test('post writes to the project timeline with no issue and no claim, and two first posts create one timeline', async t => {
  await runTimelineFlow(store(t).db);
});

test('posts carry a handle, via and a reply on the same issue, stars are idempotent, and posts lists them by project', async t => {
  await runPostsFlow(store(t).db);
});

test('a populated schema 10 store upgrades to schema 11: comments keep no voice and no stars, events keep their seq, and posts follow', async t => {
  const directory = join(root(t), 'populated'); mkdirSync(directory, { mode: 0o700 });
  const path = join(directory, 'polylinedb.sqlite');
  const legacy = new DatabaseSync(path); legacy.exec(SCHEMA_V10_SQL);
  let populated: Awaited<ReturnType<typeof populateSchema10>>; let before: Awaited<ReturnType<typeof readEvents>>;
  try { populated = await populateSchema10(executor(legacy)); before = await readEvents(executor(legacy)); } finally { legacy.close(); }
  chmodSync(path, 0o600);
  assert.throws(() => openStore({ directory }), { code: 'unsupported_schema' }, 'a schema 10 store waits for an explicit upgrade');
  const outcome = upgradeStore({ directory }); assert.deepEqual([outcome.result, outcome.version], ['upgraded', 11]);
  const upgraded = new DatabaseSync(path); const reference = new DatabaseSync(':memory:'); reference.exec(SCHEMA_SQL);
  const schema = "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name";
  try { assert.deepEqual(upgraded.prepare(schema).all(), reference.prepare(schema).all()); } finally { upgraded.close(); reference.close(); }
  const opened = openStore({ directory }); t.after(() => opened.close());
  await checkSchema10Upgrade(opened.db, populated, before);
});

test('a snapshot keeps every post, reply and star through export and import, and a snapshot 8 imports with no voices and no stars', async t => {
  const source = store(t);
  const run = (value: unknown, actor = 'alice') => executeOperation(source.db, parseOperation(value), actor);
  const created = await run({ op: 'create', prefix: 'sn', request_id: crypto.randomUUID(), tool: 'test', project: 'posts', body: 'Threads' });
  assert.ok('issue' in created);
  const id = created.issue.id;
  const post = await run({ op: 'comment', id, body: 'Root post', handle: 'builder', via: 'claude-code opus-5.5 cloud' }); assert.ok('comment' in post);
  const reply = await run({ op: 'comment', id, body: 'First reply', handle: 'tester', reply_to: post.comment.id }); assert.ok('comment' in reply);
  await run({ op: 'comment', id, body: 'Second reply', reply_to: reply.comment.id });
  await run({ op: 'star', id, comment_id: post.comment.id });
  await run({ op: 'star', id, comment_id: post.comment.id, handle: 'scout' }, 'bob');
  await run({ op: 'star', id, comment_id: reply.comment.id, handle: 'coordinator' });

  const exported = source.exportSnapshot();
  assert.equal(exported.version, 9);
  assert.equal(exported.stars.length, 3);
  assert.deepEqual(exported.comments.map(comment => comment.reply_to === null ? 0 : comment.reply_to === post.comment.id ? 1 : 2), [0, 1, 2], 'a reply follows its target');
  const wire = JSON.parse(JSON.stringify(exported));
  assert.equal(canonicalSnapshot(parseSnapshot(wire)), canonicalSnapshot(exported));

  const destination = store(t);
  const imported = destination.importSnapshot(wire);
  assert.deepEqual([imported.result, imported.comments, imported.stars], ['imported', 3, 3]);
  assert.equal(canonicalSnapshot(destination.exportSnapshot()), canonicalSnapshot(exported));
  assert.equal(destination.importSnapshot(wire).result, 'already_present');
  const shown = await executeOperation(destination.db, parseOperation({ op: 'show', id }), 'alice'); assert.ok('comments' in shown);
  // The three comments can share a millisecond, and show then orders them by id, so each is found by its text.
  const voices = new Map(shown.comments.map(comment => [comment.body, [comment.handle, comment.stars, comment.starrers?.length]]));
  assert.deepEqual(Object.fromEntries(voices), { 'Root post': ['builder', 2, 2], 'First reply': ['tester', 1, 1], 'Second reply': [null, 0, 0] });

  // A snapshot written by schema 10 has no voice and no stars; it converts with nulls and imports.
  const { stars: _stars, ...rest } = exported;
  const old = { ...rest, version: 8, comments: exported.comments.map(({ handle: _h, via: _v, reply_to: _r, ...comment }) => comment) };
  assert.throws(() => parseSnapshot(old), { code: 'invalid_snapshot' });
  const converted = convertSnapshotV8(JSON.parse(JSON.stringify(old)));
  assert.deepEqual([converted.version, converted.stars], [9, []]);
  const restored = store(t);
  assert.equal(restored.importSnapshot(converted).result, 'imported');
  const plain = await executeOperation(restored.db, parseOperation({ op: 'show', id }), 'alice'); assert.ok('comments' in plain);
  assert.deepEqual(plain.comments.map(comment => [comment.body, comment.handle, comment.via, comment.reply_to, comment.stars]).sort(),
    [['First reply', null, null, null, 0], ['Root post', null, null, null, 0], ['Second reply', null, null, null, 0]]);
  const posts = await executeOperation(restored.db, parseOperation({ op: 'posts', project: 'posts' }), 'alice'); assert.ok('posts' in posts);
  assert.deepEqual(posts.posts, []);
});

test('post input is strict: the handle rule, via bytes, comment IDs, and the posts filters', () => {
  const issue = { op: 'comment', id: 'pd-1', body: 'text' };
  for (const handle of ['builder', 'tester', 'scout', 'coordinator', 'a', 'claude-code.opus_5', '9lives', 'x'.repeat(64)]) {
    assert.deepEqual(parseOperation({ ...issue, handle }), { ...issue, handle });
  }
  for (const handle of ['', 'Builder', '@builder', '-builder', '.hidden', '_x', 'two words', 'x'.repeat(65), 'café', 'polylinedb/main', 5, null]) {
    assert.throws(() => parseOperation({ ...issue, handle }), { code: 'invalid_input' }, JSON.stringify(handle));
  }
  assert.deepEqual(parseOperation({ ...issue, via: 'claude-code opus-5.5 cloud' }), { ...issue, via: 'claude-code opus-5.5 cloud' });
  assert.deepEqual(parseOperation({ ...issue, via: 'é'.repeat(64) }), { ...issue, via: 'é'.repeat(64) }, '128 UTF-8 bytes');
  for (const via of ['', '   ', 'é'.repeat(64) + 'x', 'line\nbreak', 'tab\there', 'nul\u0000', 7]) {
    assert.throws(() => parseOperation({ ...issue, via }), { code: 'invalid_input' }, JSON.stringify(via));
  }
  assert.throws(() => parseOperation({ ...issue, reply_to: 'not-a-uuid' }), { code: 'invalid_input' });
  const target = crypto.randomUUID();
  assert.deepEqual(parseOperation({ ...issue, reply_to: target.toUpperCase() }), { ...issue, reply_to: target }, 'a comment ID reads like every other UUID, in lowercase');
  const comment_id = crypto.randomUUID();
  assert.deepEqual(parseOperation({ op: 'star', id: 'pd-1', comment_id }), { op: 'star', id: 'pd-1', comment_id });
  assert.deepEqual(parseOperation({ op: 'unstar', id: 'pd-1', comment_id, handle: 'tester' }), { op: 'unstar', id: 'pd-1', comment_id, handle: 'tester' });
  for (const bad of [{ op: 'star', id: 'pd-1' }, { op: 'star', id: 'pd-1', comment_id, via: 'x' }, { op: 'unstar', id: 'nope', comment_id }, { op: 'star', id: 'pd-1', comment_id, handle: 'Tester' }]) {
    assert.throws(() => parseOperation(bad), { code: 'invalid_input' }, JSON.stringify(bad));
  }
  assert.deepEqual(parseOperation({ op: 'posts', project: 'p' }), { op: 'posts', project: 'p', min_stars: 0, limit: 50 });
  assert.deepEqual(parseOperation({ op: 'posts', project: 'p', handle: 'scout', min_stars: 2, since: '2026-10-24', after: comment_id, limit: 100 }),
    { op: 'posts', project: 'p', handle: 'scout', min_stars: 2, since: '2026-10-24T00:00:00.000Z', after: comment_id, limit: 100 });
  assert.equal((parseOperation({ op: 'posts', project: 'p', since: '2026-10-24T09:30+09:00' }) as { since: string }).since, '2026-10-24T00:30:00.000Z');
  assert.deepEqual(parseOperation({ op: 'posts' }), { op: 'posts', min_stars: 0, limit: 50 }, 'without a project, posts reads every project');
  for (const bad of [{ op: 'posts', project: '' }, { op: 'posts', project: 'p', since: '2026-02-30' }, { op: 'posts', project: 'p', since: '2026-10-24T09:00:00' }, { op: 'posts', project: 'p', since: 'yesterday' },
    { op: 'posts', project: 'p', min_stars: -1 }, { op: 'posts', project: 'p', limit: 0 }, { op: 'posts', project: 'p', limit: 101 }, { op: 'posts', project: 'p', after: 'pd-1' }, { op: 'posts', project: 'p', via: 'x' }]) {
    assert.throws(() => parseOperation(bad), { code: 'invalid_input' }, JSON.stringify(bad));
  }
});

test('property: any star and unstar sequence leaves the stars of a model set, and the feed records only real transitions', async () => {
  let casesRun = 0;
  const actors = ['alice', 'bob'] as const;
  const handles = [undefined, 'tester', 'scout'] as const;
  await hegel.testAsync(async tc => {
    casesRun += 1;
    const directory = mkdtempSync(join(tmpdir(), 'pd-posts-property-'));
    try {
      initializeStore({ directory: join(directory, 'store') });
      const opened = openStore({ directory: join(directory, 'store') });
      try {
        const run = (value: unknown, actor: string) => executeOperation(opened.db, parseOperation(value), actor);
        const created = await run({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'hegel', project: 'stars', body: 'Stars' }, 'alice');
        assert.ok('issue' in created);
        const written = await run({ op: 'comment', id: created.issue.id, body: 'A post', handle: 'builder' }, 'alice');
        assert.ok('comment' in written);
        const steps = tc.draw(gs.arrays(gs.record({ star: gs.booleans(), actor: gs.sampledFrom([...actors]), handle: gs.sampledFrom([...handles]) }), { minSize: 1, maxSize: 12 }));
        // The model: one entry per starrer, holding the actor that gave the star.
        const model = new Map<string, string>();
        let transitions = 0;
        for (const step of steps) {
          const starrer = step.handle ?? step.actor;
          const input = { op: step.star ? 'star' : 'unstar', id: created.issue.id, comment_id: written.comment.id, ...(step.handle === undefined ? {} : { handle: step.handle }) };
          const owner = model.get(starrer);
          try {
            const result = await run(input, step.actor);
            assert.ok('outcome' in result);
            if (step.star) {
              assert.equal(result.outcome, owner === undefined ? 'added' : 'already_present');
              assert.equal(result.star?.actor, owner ?? step.actor);
              if (owner === undefined) { model.set(starrer, step.actor); transitions += 1; }
            } else {
              assert.notEqual(owner !== undefined && owner !== step.actor, true, 'another actor removed a star');
              assert.equal(result.outcome, owner === undefined ? 'already_absent' : 'removed');
              if (owner !== undefined) { model.delete(starrer); transitions += 1; }
            }
          } catch (error) {
            if (!(error instanceof PolylinedbError)) throw error;
            assert.equal(error.code, 'star_owner_required');
            assert.ok(!step.star && owner !== undefined && owner !== step.actor, `${error.code} for ${JSON.stringify(step)}`);
          }
        }
        const rows = await opened.db.batch([{ sql: 'SELECT starrer, actor FROM stars ORDER BY starrer', params: [] }]);
        assert.deepEqual((rows[0]?.rows ?? []).map(row => [row.starrer, row.actor]), [...model.entries()].sort(([left], [right]) => left < right ? -1 : 1));
        const shown = await run({ op: 'show', id: created.issue.id }, 'alice');
        assert.ok('comments' in shown);
        assert.equal(shown.comments[0]?.stars, model.size);
        const recorded = await run({ op: 'changes', since: 0, kinds: ['starred', 'unstarred'], limit: 100 }, 'alice');
        assert.ok('next_since' in recorded);
        assert.equal(recorded.changes.length, transitions);
      } finally { opened.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, { testCases: propertyCases, seed: 20261024, database: hegel.Database.fromPath('.hegel') });
  assert.ok(casesRun > 0);
});
