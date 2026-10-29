// Runs posts, replies, stars, and the schema 10 to 11 upgrade on one store; local SQLite and workerd D1 run the same flows.
import assert from 'node:assert/strict';
import { executeOperation, parseOperation } from '../../src/records/index.ts';
import { PolylinedbError } from '../../src/records/store/errors.ts';
import type { Actor } from '../../src/records/index.ts';
import type { SqlExecutor } from '../../src/records/persistence/persistence.ts';
import { legacyComment } from './legacy-schema.ts';

type Refusal = { code: string; status: number; details: unknown };
type Row = Record<string, unknown>;

function helpers(db: SqlExecutor) {
  const run = async (value: unknown, actor: string | Actor = 'alice'): Promise<Row> => await executeOperation(db, parseOperation(value), actor) as Row;
  // Plain objects, so node:sqlite and D1 rows compare alike.
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
    return (page.changes as Row[]).filter(change => Number(change.seq) > since).map(({ issue_id, kind, actor }) => ({ issue_id, kind, actor }));
  };
  return { run, sql, latest, refusal, events };
}

const agent: Actor = { id: 'service:scout', kind: 'agent' };
const via = 'claude-code opus-5.5 cloud';
const create = (project: string, body: string) => ({ op: 'create', prefix: 'po', request_id: crypto.randomUUID(), tool: 'test', project, body, labels: ['ready'] });

export async function runPostsFlow(db: SqlExecutor): Promise<void> {
  const { run, sql, latest, refusal, events } = helpers(db);
  const first = ((await run(create('posts', 'First issue'))).issue as Row & { id: string }).id;
  const second = ((await run(create('posts', 'Second issue'))).issue as Row & { id: string }).id;
  const elsewhere = ((await run(create('elsewhere', 'Other project'))).issue as Row & { id: string }).id;

  // A post is a comment with a handle; the handle and via are attribution, and created_by stays the authenticated actor.
  const start = await latest();
  const post = (await run({ op: 'comment', id: first, body: 'Parser plan', handle: 'builder', via })).comment as Row & { id: string };
  assert.deepEqual([post.handle, post.via, post.reply_to, post.created_by, post.version], ['builder', via, null, 'alice', 1]);
  const reply = (await run({ op: 'comment', id: first, body: 'Tests pass', handle: 'tester', reply_to: post.id }, 'bob')).comment as Row & { id: string };
  assert.deepEqual([reply.handle, reply.via, reply.reply_to, reply.created_by], ['tester', null, post.id, 'bob']);
  const plain = (await run({ op: 'comment', id: first, body: 'A plain comment' })).comment as Row & { id: string };
  assert.deepEqual([plain.handle, plain.via, plain.reply_to], [null, null, null]);
  const answer = (await run({ op: 'comment', id: first, body: 'A reply without a voice', reply_to: reply.id })).comment as Row & { id: string };
  assert.deepEqual([answer.handle, answer.reply_to], [null, reply.id]);
  const other = (await run({ op: 'comment', id: elsewhere, body: 'Elsewhere', handle: 'builder' })).comment as Row & { id: string };
  // Two comments can share a millisecond, so the order checks below place the post and the reply a second apart. Writes outside an operation record no event.
  await sql("UPDATE comments SET created_at = '2026-03-01T00:00:00.000Z' WHERE id = ?", post.id);
  await sql("UPDATE comments SET created_at = '2026-03-01T00:00:01.000Z' WHERE id = ?", reply.id);
  post.created_at = '2026-03-01T00:00:00.000Z'; reply.created_at = '2026-03-01T00:00:01.000Z';
  // show orders comments by time, and comments of the same millisecond by their random ids, so the two voiceless comments get times of their own.
  await sql("UPDATE comments SET created_at = CASE id WHEN ? THEN '2026-03-01T00:00:02.000Z' ELSE '2026-03-01T00:00:03.000Z' END WHERE id IN (?, ?)", plain.id, plain.id, answer.id);
  assert.deepEqual(await events(start), [
    { issue_id: first, kind: 'commented', actor: 'alice' }, { issue_id: first, kind: 'commented', actor: 'bob' },
    { issue_id: first, kind: 'commented', actor: 'alice' }, { issue_id: first, kind: 'commented', actor: 'alice' },
    { issue_id: elsewhere, kind: 'commented', actor: 'alice' },
  ]);

  // A reply names a comment on the same issue; a target on another issue or no comment at all is refused, and nothing is written.
  const refused = await latest();
  const comments = async () => Number((await sql('SELECT COUNT(*) AS n FROM comments'))[0]?.n);
  const before = await comments();
  assert.deepEqual(await refusal(run({ op: 'comment', id: second, body: 'Across issues', reply_to: post.id })),
    { code: 'reply_target_not_found', status: 404, details: { id: second, reply_to: post.id } });
  const missing = crypto.randomUUID();
  assert.deepEqual(await refusal(run({ op: 'comment', id: first, body: 'To nothing', reply_to: missing })),
    { code: 'reply_target_not_found', status: 404, details: { id: first, reply_to: missing } });
  assert.deepEqual(await refusal(run({ op: 'comment', id: 'po-99', body: 'No issue', reply_to: post.id })), { code: 'not_found', status: 404, details: { id: 'po-99' } });
  assert.deepEqual(await refusal(run({ op: 'comment', id: second, body: 'Agent across issues', reply_to: post.id }, agent)),
    { code: 'reply_target_not_found', status: 404, details: { id: second, reply_to: post.id } }, 'the reply target is checked before the claim');
  assert.deepEqual(await refusal(run({ op: 'comment', id: first, body: 'Agent reply', reply_to: post.id }, agent)), { code: 'claim_required', status: 409, details: { id: first } });
  // The trigger refuses a reply across issues on a path that skips the operation, such as a restore.
  await assert.rejects(sql('INSERT INTO comments(id,issue_id,body,created_at,created_by,reply_to) VALUES (?,?,?,?,?,?)', crypto.randomUUID(), second, 'raw', '2026-01-01T00:00:00.000Z', 'alice', post.id),
    /reply_target_not_found/);
  assert.equal(await comments(), before);
  assert.equal(await latest(), refused, 'a refused comment records no event');

  // Stars: one per starrer, which is the handle when one is given and the actor otherwise. Only a real change records an event.
  const stars = await latest();
  const added = await run({ op: 'star', id: first, comment_id: post.id });
  assert.equal(added.outcome, 'added');
  const own = added.star as Row;
  assert.deepEqual({ ...own, created_at: typeof own.created_at }, { comment_id: post.id, starrer: 'alice', handle: null, actor: 'alice', created_at: 'string' });
  assert.deepEqual(await run({ op: 'star', id: first, comment_id: post.id }), { star: own, outcome: 'already_present' }, 'a repeated star returns the star that exists');
  const persona = await run({ op: 'star', id: first, comment_id: post.id, handle: 'tester' }, 'bob');
  assert.deepEqual([persona.outcome, (persona.star as Row).starrer, (persona.star as Row).actor], ['added', 'tester', 'bob']);
  assert.deepEqual(await run({ op: 'star', id: first, comment_id: post.id, handle: 'tester' }, 'carol'), { star: persona.star, outcome: 'already_present' },
    'one persona stars a post once, whoever speaks as it');
  const agentStar = await run({ op: 'star', id: first, comment_id: reply.id }, agent);
  assert.equal(agentStar.outcome, 'added', 'a star needs no claim');
  assert.deepEqual(await events(stars), [
    { issue_id: first, kind: 'starred', actor: 'alice' }, { issue_id: first, kind: 'starred', actor: 'bob' }, { issue_id: first, kind: 'starred', actor: agent.id },
  ]);

  const unchanged = await latest();
  assert.deepEqual(await refusal(run({ op: 'star', id: second, comment_id: post.id })), { code: 'comment_not_found', status: 404, details: { id: second, comment_id: post.id } });
  assert.deepEqual(await refusal(run({ op: 'star', id: first, comment_id: missing })), { code: 'comment_not_found', status: 404, details: { id: first, comment_id: missing } });
  assert.deepEqual(await refusal(run({ op: 'star', id: 'po-99', comment_id: post.id })), { code: 'not_found', status: 404, details: { id: 'po-99' } });
  assert.deepEqual(await refusal(run({ op: 'unstar', id: first, comment_id: post.id, handle: 'tester' }, 'carol')),
    { code: 'star_owner_required', status: 403, details: { id: first, comment_id: post.id, starrer: 'tester' } }, 'a handle grants nothing');
  assert.deepEqual(await refusal(run({ op: 'unstar', id: second, comment_id: post.id })), { code: 'comment_not_found', status: 404, details: { id: second, comment_id: post.id } });
  assert.deepEqual(await run({ op: 'unstar', id: first, comment_id: post.id }, 'carol'), { star: null, outcome: 'already_absent' }, 'carol never starred as herself');
  assert.equal(await latest(), unchanged, 'refusals and no-ops record no event');

  assert.deepEqual(await run({ op: 'unstar', id: first, comment_id: post.id }), { star: own, outcome: 'removed' });
  assert.deepEqual(await run({ op: 'unstar', id: first, comment_id: post.id }), { star: null, outcome: 'already_absent' });
  assert.deepEqual(await events(unchanged), [{ issue_id: first, kind: 'unstarred', actor: 'alice' }]);
  await run({ op: 'star', id: first, comment_id: post.id });

  // show carries the voice of every comment and its stars; starrers lists the oldest first, so two stars of the same millisecond are placed apart.
  await sql("UPDATE stars SET created_at = CASE starrer WHEN 'tester' THEN '2026-03-02T00:00:00.000Z' ELSE '2026-03-02T00:00:01.000Z' END WHERE comment_id = ?", post.id);
  const shown = (await run({ op: 'show', id: first })).comments as Row[];
  assert.deepEqual(shown.map(({ id, handle, via, reply_to, stars, starrers }) => ({ id, handle, via, reply_to, stars, starrers })), [
    { id: post.id, handle: 'builder', via, reply_to: null, stars: 2, starrers: ['tester', 'alice'] },
    { id: reply.id, handle: 'tester', via: null, reply_to: post.id, stars: 1, starrers: [agent.id] },
    { id: plain.id, handle: null, via: null, reply_to: null, stars: 0, starrers: [] },
    { id: answer.id, handle: null, via: null, reply_to: reply.id, stars: 0, starrers: [] },
  ]);

  // posts lists comments with a handle in one project, newest first, with each star count.
  const listed = async (input: Row) => {
    const page = await run({ op: 'posts', project: 'posts', ...input });
    return { ids: (page.posts as Row[]).map(entry => entry.id), next_cursor: page.next_cursor };
  };
  assert.deepEqual(await listed({}), { ids: [reply.id, post.id], next_cursor: null });
  const page = await run({ op: 'posts', project: 'posts' });
  assert.deepEqual((page.posts as Row[]).map(({ stars, starrers }) => [stars, starrers]), [[1, [agent.id]], [2, ['tester', 'alice']]]);
  assert.deepEqual(await listed({ handle: 'builder' }), { ids: [post.id], next_cursor: null });
  assert.deepEqual(await listed({ handle: 'scout' }), { ids: [], next_cursor: null });
  assert.deepEqual(await listed({ min_stars: 2 }), { ids: [post.id], next_cursor: null });
  assert.deepEqual(await listed({ min_stars: 3 }), { ids: [], next_cursor: null });
  assert.deepEqual(await listed({ since: '2000-01-01' }), { ids: [reply.id, post.id], next_cursor: null });
  assert.deepEqual(await listed({ since: '2999-01-01T00:00:00+09:00' }), { ids: [], next_cursor: null });
  assert.deepEqual(await listed({ since: '2026-03-01T00:00:01Z' }), { ids: [reply.id], next_cursor: null }, 'since keeps a post created at that instant');
  assert.deepEqual(await listed({ since: '2026-03-01T09:00:00.001+09:00' }), { ids: [reply.id], next_cursor: null }, 'since reads the time zone');
  assert.deepEqual(await listed({ limit: 1 }), { ids: [reply.id], next_cursor: reply.id });
  assert.deepEqual(await listed({ limit: 1, after: reply.id }), { ids: [post.id], next_cursor: null });
  assert.deepEqual(await listed({ after: crypto.randomUUID() }), { ids: [], next_cursor: null }, "a cursor that names no comment gives an empty page");
  assert.deepEqual((await run({ op: 'posts', project: 'elsewhere' })).posts, [{ ...other, stars: 0, starrers: [] }]);
  assert.deepEqual(await refusal(run({ op: 'posts', project: 'posts', since: '2026-02-30' })), { code: 'invalid_input', status: 400, details: undefined });

  // Two posts in the same millisecond page by id, so a page boundary between them loses neither.
  const instant = '2026-01-01T00:00:00.000Z';
  const twins = [crypto.randomUUID(), crypto.randomUUID()].sort().reverse();
  for (const id of twins) await sql("INSERT INTO comments(id,issue_id,body,created_at,created_by,handle) VALUES (?,?,'twin',?,'alice','coordinator')", id, second, instant);
  const firstTwin = await run({ op: 'posts', project: 'posts', handle: 'coordinator', limit: 1 });
  assert.deepEqual([(firstTwin.posts as Row[]).map(entry => entry.id), firstTwin.next_cursor], [[twins[0]], twins[0]]);
  const secondTwin = await run({ op: 'posts', project: 'posts', handle: 'coordinator', limit: 1, after: twins[0] });
  assert.deepEqual([(secondTwin.posts as Row[]).map(entry => entry.id), secondTwin.next_cursor], [[twins[1]], null]);

  // Two writers that star as the same persona at once: exactly one star lands and one event records it.
  const raced = await latest();
  const racing = await Promise.all(['dave', 'erin'].map(actor => run({ op: 'star', id: first, comment_id: plain.id, handle: 'coordinator' }, actor)));
  assert.deepEqual(racing.map(result => result.outcome).sort(), ['added', 'already_present']);
  assert.equal((await events(raced)).length, 1);
}

/** Writes rows and change events into a schema 10 store, so the upgrade has comments and events that a reader's cursor already holds. */
export async function populateSchema10(db: SqlExecutor): Promise<{ comment_id: string; id: string }> {
  const { run } = helpers(db);
  const id = ((await run(create('posts', 'Before posts'))).issue as Row & { id: string }).id;
  const comment_id = await legacyComment(db, { issue_id: id, body: 'kept note', actor: 'alice' });
  await run({ op: 'update', id, changes: [{ field: 'priority', value: 1, expected: 1 }] });
  return { comment_id, id };
}

export async function readEvents(db: SqlExecutor): Promise<Row[]> {
  return await helpers(db).sql('SELECT * FROM change_events ORDER BY seq');
}

/** Checks a store that upgraded from schema 10 after populateSchema10: the comment has no voice and no stars, events keep their seq, and posts continue after them. */
export async function checkSchema10Upgrade(db: SqlExecutor, populated: { comment_id: string; id: string }, before: Row[]): Promise<void> {
  const { run, sql, latest } = helpers(db);
  assert.equal(before.length, 3);
  assert.deepEqual(await readEvents(db), before, 'the rebuild keeps every event with its seq');
  assert.deepEqual(await sql('SELECT version FROM schema_version'), [{ version: 11 }]);
  assert.deepEqual(await sql('SELECT handle, via, reply_to FROM comments'), [{ handle: null, via: null, reply_to: null }]);
  assert.deepEqual(await sql('SELECT * FROM stars'), []);
  const shown = (await run({ op: 'show', id: populated.id })).comments as Row[];
  assert.deepEqual(shown.map(({ id, handle, stars, starrers }) => ({ id, handle, stars, starrers })), [{ id: populated.comment_id, handle: null, stars: 0, starrers: [] }]);
  assert.deepEqual((await run({ op: 'posts', project: 'posts' })).posts, [], 'a comment from before posts has no handle, so it is no post');
  const last = await latest();
  assert.equal(last, Number(before.at(-1)?.seq));
  const reply = (await run({ op: 'comment', id: populated.id, body: 'A reply after the upgrade', handle: 'scout', reply_to: populated.comment_id })).comment as Row & { id: string };
  await run({ op: 'star', id: populated.id, comment_id: populated.comment_id, handle: 'tester' });
  await run({ op: 'unstar', id: populated.id, comment_id: populated.comment_id, handle: 'tester' });
  const page = await run({ op: 'changes', since: 0, limit: 100 });
  assert.deepEqual((page.changes as Row[]).filter(change => Number(change.seq) > last).map(({ seq, issue_id, kind }) => ({ seq, issue_id, kind })), [
    { seq: last + 1, issue_id: populated.id, kind: 'commented' },
    { seq: last + 2, issue_id: populated.id, kind: 'starred' },
    { seq: last + 3, issue_id: populated.id, kind: 'unstarred' },
  ]);
  assert.deepEqual(((await run({ op: 'posts', project: 'posts' })).posts as Row[]).map(entry => entry.id), [reply.id]);
}

// A post needs no issue: it goes to the project's timeline, one closed issue created on the first post with a request ID named by the project.
export async function runTimelineFlow(db: SqlExecutor): Promise<void> {
  const { run, sql, latest, refusal, events } = helpers(db);
  const timelines = async (project: string) => (await sql("SELECT issues.id FROM issues, json_each(issues.labels_json) WHERE issues.project = ? AND json_each.value = 'timeline'", project)).map(row => row.id);

  const empty = await latest();
  assert.deepEqual(await refusal(run({ op: 'post', project: 'quiet', body: 'Nowhere to go', handle: 'builder' }, agent)),
    { code: 'not_found', status: 404, details: { project: 'quiet', did_you_mean: [] } }, 'a project with no issue has no prefix to name a timeline');
  assert.equal(await latest(), empty);

  const work = ((await run({ op: 'create', prefix: 'tl', request_id: crypto.randomUUID(), tool: 'timeline-tool', project: 'loud', body: 'Some work' })).issue as Row & { id: string }).id;
  for (const near of ['acme/loud', 'LOUD']) {
    assert.deepEqual(await refusal(run({ op: 'post', project: near, body: 'Close enough', handle: 'builder' }, agent)),
      { code: 'not_found', status: 404, details: { project: near, did_you_mean: ['loud'] } }, 'a short or differently cased name points at the project it likely means');
  }
  await run({ op: 'create', prefix: 'tl', request_id: crypto.randomUUID(), tool: 'timeline-tool', project: 'acme/tide', body: 'Other work' });
  assert.deepEqual(await refusal(run({ op: 'post', project: 'tide', body: 'Close enough', handle: 'builder' }, agent)),
    { code: 'not_found', status: 404, details: { project: 'tide', did_you_mean: ['acme/tide'] } }, 'a repository name without its owner points at the full name');
  await assert.rejects(run({ op: 'post', project: 'acme/loud', body: 'Close enough', handle: 'builder' }, agent), /Did you mean loud\?/);
  const before = await latest();
  const first = (await run({ op: 'post', project: 'loud', body: 'Strip ANSI before reading CI output', handle: 'builder', via }, agent)).comment as Row & { id: string; issue_id: string };
  const timeline = (await run({ op: 'show', id: first.issue_id })).issue as Row;
  assert.deepEqual({ ...timeline, id: typeof timeline.id, versions: undefined, created_at: undefined, updated_at: undefined, closed_at: typeof timeline.closed_at }, {
    id: 'string', tool: 'timeline-tool', project: 'loud', body: 'Timeline\n\nPosts on loud that belong to no single issue. The post operation writes here; keep it closed.',
    status: 'closed', type: 'chore', priority: 4, labels: ['timeline'], versions: undefined, created_at: undefined, created_by: agent.id,
    updated_at: undefined, updated_by: agent.id, closed_at: 'string', closed_by: agent.id }, 'an agent posts with no claim, and the timeline takes the prefix and tool of the project');
  assert.match(String(timeline.id), /^tl-\d+$/);
  assert.notEqual(timeline.id, work);
  assert.deepEqual([first.handle, first.via, first.reply_to, first.created_by], ['builder', via, null, agent.id]);
  assert.deepEqual(await events(before), [{ issue_id: timeline.id, kind: 'created', actor: agent.id }, { issue_id: timeline.id, kind: 'commented', actor: agent.id }]);

  const reply = (await run({ op: 'post', project: 'loud', body: 'Same here w', handle: 'tester', reply_to: first.id }, 'bob')).comment as Row;
  assert.deepEqual([reply.issue_id, reply.reply_to, reply.via], [timeline.id, first.id, null], 'a later post finds the timeline whoever writes it');
  assert.deepEqual(await timelines('loud'), [timeline.id]);
  const onWork = (await run({ op: 'comment', id: work, body: 'On the work issue' })).comment as Row & { id: string };
  assert.deepEqual(await refusal(run({ op: 'post', project: 'loud', body: 'Across', handle: 'tester', reply_to: onWork.id })),
    { code: 'reply_target_not_found', status: 404, details: { id: timeline.id, reply_to: onWork.id } });
  assert.deepEqual(await refusal(run({ op: 'comment', id: String(timeline.id), body: 'Plain comment', handle: 'builder' }, agent)),
    { code: 'claim_required', status: 409, details: { id: timeline.id } }, 'a comment keeps the claim gate; only post skips it');
  assert.deepEqual(((await run({ op: 'posts', project: 'loud' })).posts as Row[]).map(entry => entry.id), [reply.id, first.id]);
  const star = await run({ op: 'star', id: String(timeline.id), comment_id: first.id });
  assert.equal(star.outcome, 'added', 'a timeline post stars like any post');

  // Two first posts at once create one timeline: the second create meets the first one's request ID and reads the issue it made.
  await run({ op: 'create', prefix: 'tl', request_id: crypto.randomUUID(), tool: 'timeline-tool', project: 'race', body: 'Race work' });
  const raced = await Promise.all(['carol', 'dave', 'erin'].map(actor => run({ op: 'post', project: 'race', body: `From ${actor}`, handle: 'scout' }, actor)));
  const raceTimelines = await timelines('race');
  assert.equal(raceTimelines.length, 1);
  assert.deepEqual(raced.map(result => (result.comment as Row).issue_id), [raceTimelines[0], raceTimelines[0], raceTimelines[0]]);

  assert.deepEqual(await refusal(run({ op: 'post', project: 'loud', body: 'No voice' })), { code: 'invalid_input', status: 400, details: undefined }, 'a post needs a handle');
}
