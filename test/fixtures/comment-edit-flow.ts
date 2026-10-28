// Runs the comment edit contract and the schema 9 to 10 upgrade on one store; local SQLite and workerd D1 run the same flows.
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
    return assert.fail('The edit was accepted');
  };
  const edits = async (since: number) => {
    const page = await run({ op: 'changes', since: 0, kinds: ['comment_edited'], limit: 100 });
    return (page.changes as Row[]).filter(change => Number(change.seq) > since).map(({ issue_id, kind, fields, actor }) => ({ issue_id, kind, fields, actor }));
  };
  return { run, sql, latest, refusal, edits };
}

const agent: Actor = { id: 'service:agent', kind: 'agent' };

export async function runCommentEditFlow(db: SqlExecutor): Promise<void> {
  const { run, sql, latest, refusal, edits } = helpers(db);
  const created = await run({ op: 'create', prefix: 'ce', request_id: crypto.randomUUID(), tool: 'test', project: 'edits', body: 'Comment edits', labels: ['ready'] });
  const id = (created.issue as { id: string }).id;
  const written = (await run({ op: 'comment', id, body: 'first draft words' })).comment as Row & { id: string };
  assert.deepEqual([written.version, written.updated_at, written.updated_by], [1, null, null]);
  const issueBefore = (await run({ op: 'show', id })).issue;
  const start = await latest();

  const edit = { op: 'comment_edit', id, comment_id: written.id, body: 'second draft words', expected: 1 };
  const edited = (await run(edit)).comment as Row;
  assert.equal(typeof edited.updated_at, 'string');
  assert.deepEqual(edited, { ...written, body: 'second draft words', version: 2, updated_at: edited.updated_at, updated_by: 'alice' });
  assert.deepEqual(await edits(start), [{ issue_id: id, kind: 'comment_edited', fields: [], actor: 'alice' }]);
  const shown = await run({ op: 'show', id });
  assert.deepEqual(shown.comments, [{ ...edited, stars: 0, starrers: [] }], 'show adds the stars, which a write result leaves out');
  assert.deepEqual(shown.issue, issueBefore, 'an edit leaves the issue fields, versions and updated_at as they were');
  assert.deepEqual(((await run({ op: 'search', query: 'second' })).issues as Row[]).map(issue => issue.id), [id]);
  assert.deepEqual((await run({ op: 'search', query: 'first' })).issues, []);

  const afterEdit = await latest();
  assert.deepEqual(await refusal(run(edit)), { code: 'comment_conflict', status: 409, details: { comment: edited, expected: 1 } });
  const foreign = await refusal(run({ ...edit, expected: 2 }, 'bob'));
  assert.deepEqual(foreign, { code: 'comment_author_required', status: 403, details: { id, comment_id: written.id } });
  const missing = crypto.randomUUID();
  assert.deepEqual(await refusal(run({ ...edit, comment_id: missing, expected: 2 })), { code: 'comment_not_found', status: 404, details: { id, comment_id: missing } });
  assert.deepEqual(await refusal(run({ ...edit, id: 'ce-99', expected: 2 })), { code: 'not_found', status: 404, details: { id: 'ce-99' } });
  assert.deepEqual(await refusal(run({ ...edit, expected: 2 }, agent)), { code: 'comment_author_required', status: 403, details: { id, comment_id: written.id } }, 'authorship is checked before the claim');
  assert.equal(await latest(), afterEdit, 'a refused edit records no event');
  assert.deepEqual((await run({ op: 'show', id })).comments, [{ ...edited, stars: 0, starrers: [] }]);

  // An agent comment needs a claim to write, and so does its edit.
  const agentComment = crypto.randomUUID();
  await sql("INSERT INTO comments(id,issue_id,body,created_at,created_by) VALUES (?,?,'agent note','2021-01-01T00:00:00.000Z',?)", agentComment, id, agent.id);
  const agentEdit = { op: 'comment_edit', id, comment_id: agentComment, body: 'agent note, revised', expected: 1 };
  assert.deepEqual(await refusal(run(agentEdit, agent)), { code: 'claim_required', status: 409, details: { id } });
  const incarnation = (await run({ op: 'changes', since: 0 })).incarnation;
  await run({ op: 'claim_acquire', issue_id: id, incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), ttl: 600 }, agent);
  const agentEdited = (await run(agentEdit, agent)).comment as Row;
  assert.deepEqual([agentEdited.version, agentEdited.updated_by, agentEdited.body], [2, agent.id, 'agent note, revised']);

  // Two writers that read the same version: exactly one edit lands.
  const raced = (await run({ op: 'comment', id, body: 'race start' })).comment as Row & { id: string };
  const racing = await Promise.allSettled(['race left', 'race right'].map(body => run({ op: 'comment_edit', id, comment_id: raced.id, body, expected: 1 })));
  const won = racing.filter(result => result.status === 'fulfilled');
  const lost = racing.filter(result => result.status === 'rejected');
  assert.equal(won.length, 1); assert.equal(lost.length, 1);
  assert.equal((lost[0]?.reason as PolylinedbError).code, 'comment_conflict');
  const winner = (won[0]?.value as Row).comment as Row;
  const final = ((await run({ op: 'show', id })).comments as Row[]).find(comment => comment.id === raced.id);
  assert.deepEqual(final, { ...winner, stars: 0, starrers: [] }); assert.equal(winner.version, 2);

  // Writes outside an operation record no event, so the version can be placed at its limit.
  await sql("UPDATE comments SET version = ?, updated_at = '2021-01-02T00:00:00.000Z', updated_by = created_by WHERE id = ?", Number.MAX_SAFE_INTEGER, written.id);
  // A refusal names the comment as the store holds it, without the stars that show adds.
  const { stars: _stars, starrers: _starrers, ...limit } = (await run({ op: 'show', id }) as { comments: Row[] }).comments.find(comment => comment.id === written.id) ?? {};
  assert.deepEqual(await refusal(run({ ...edit, expected: Number.MAX_SAFE_INTEGER })), { code: 'comment_version_exhausted', status: 409, details: { comment: limit } });

  assert.deepEqual(await edits(start), [
    { issue_id: id, kind: 'comment_edited', fields: [], actor: 'alice' },
    { issue_id: id, kind: 'comment_edited', fields: [], actor: agent.id },
    { issue_id: id, kind: 'comment_edited', fields: [], actor: 'alice' },
  ]);
}

/** Writes rows and change events into a schema 9 store, so the upgrade has events whose seq values a reader's cursor already holds. */
export async function populateSchema9(db: SqlExecutor): Promise<{ comment_id: string; id: string }> {
  const { run } = helpers(db);
  const first = await run({ op: 'create', prefix: 'up', request_id: crypto.randomUUID(), tool: 'test', project: 'upgrade', body: 'Before the upgrade' });
  const id = (first.issue as { id: string }).id;
  await run({ op: 'create', prefix: 'up', request_id: crypto.randomUUID(), tool: 'test', project: 'upgrade', body: 'Second issue' });
  const comment_id = await legacyComment(db, { issue_id: id, body: 'kept note', actor: 'alice' });
  await run({ op: 'update', id, changes: [{ field: 'priority', value: 1, expected: 1 }] });
  return { comment_id, id };
}

export async function readEvents(db: SqlExecutor): Promise<Row[]> {
  return await helpers(db).sql('SELECT * FROM change_events ORDER BY seq');
}

/** Checks a store that upgraded from schema 9 after populateSchema9: every event keeps its seq, and later writes continue after the last one. */
export async function checkSchema9Upgrade(db: SqlExecutor, populated: { comment_id: string; id: string }, before: Row[]): Promise<void> {
  const { run, sql, latest } = helpers(db);
  assert.equal(before.length, 4);
  assert.deepEqual(await readEvents(db), before, 'the rebuild keeps every event with its seq');
  assert.deepEqual(await sql('SELECT version FROM schema_version'), [{ version: 11 }]);
  assert.deepEqual(await sql('SELECT version, updated_at, updated_by FROM comments'), [{ version: 1, updated_at: null, updated_by: null }]);
  const last = await latest();
  assert.equal(last, Number(before.at(-1)?.seq));
  await run({ op: 'comment_edit', id: populated.id, comment_id: populated.comment_id, body: 'edited after the upgrade', expected: 1 });
  await run({ op: 'comment', id: populated.id, body: 'new note' });
  await run({ op: 'create', prefix: 'up', request_id: crypto.randomUUID(), tool: 'test', project: 'upgrade', body: 'After the upgrade' });
  const page = await run({ op: 'changes', since: 0, limit: 100 });
  assert.deepEqual((page.changes as Row[]).slice(-3).map(({ seq, issue_id, kind }) => ({ seq, issue_id, kind })), [
    { seq: last + 1, issue_id: populated.id, kind: 'comment_edited' },
    { seq: last + 2, issue_id: populated.id, kind: 'commented' },
    { seq: last + 3, issue_id: 'up-3', kind: 'created' },
  ]);
}
