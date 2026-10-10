// Runs one command sequence against a fresh store and checks each change event; local SQLite and workerd D1 run the same flow.
import assert from 'node:assert/strict';
import { executeOperation, parseOperation } from '../../src/records/index.ts';
import type { ChangesResult } from '../../src/records/index.ts';
import { CHANGE_RETENTION } from '../../src/records/changes-sql.ts';
import { ROTATE_MEMORY_IDENTITY_SQL } from '../../src/records/persistence.ts';
import type { SqlExecutor } from '../../src/records/persistence.ts';

export type LoggedChange = { seq: number; issue_id: string; kind: string; fields: string[]; actor: string };
type Expected = [issue_id: string, kind: string, fields?: string[], actor?: string];

const bobSession = '00000000-0000-4000-8000-0000000000b0';
const aliceSession = '00000000-0000-4000-8000-0000000000a0';
const otherIncarnation = 'f'.repeat(32);

export async function runChangeFeedFlow(db: SqlExecutor): Promise<LoggedChange[]> {
  const run = (value: unknown, actor = 'alice') => executeOperation(db, parseOperation(value), actor);
  const sql = async (statement: string, ...params: (string | number | null)[]) => (await db.batch([{ sql: statement, params }]))[0]?.rows ?? [];
  const now = async () => Number((await sql('SELECT CAST(unixepoch() AS INTEGER) AS now'))[0]?.now);
  const latest = async () => Number((await sql('SELECT COALESCE(MAX(seq), 0) AS seq FROM change_events'))[0]?.seq);
  const writerRows = async () => (await sql('SELECT * FROM change_writer')).length;
  const read = async (value: Record<string, unknown>): Promise<ChangesResult> => {
    const result = await run({ op: 'changes', ...value });
    assert.ok('next_since' in result);
    return result;
  };
  const incarnation = (await read({ since: 0 })).incarnation;
  const log: LoggedChange[] = [];

  async function records(expected: Expected[], action: () => Promise<unknown>): Promise<void> {
    const before = await latest(); const from = await now();
    await action();
    const to = await now();
    const page = await read({ since: before, incarnation, limit: 100 });
    for (const change of page.changes) {
      assert.equal(change.incarnation, incarnation);
      assert.ok(change.occurred_at >= from && change.occurred_at <= to, `occurred_at ${change.occurred_at} is database time`);
    }
    const wanted = expected.map(([issue_id, kind, fields = [], actor = 'alice'], index) => ({ seq: before + index + 1, issue_id, kind, fields, actor }));
    assert.deepEqual(page.changes.map(({ seq, issue_id, kind, fields, actor }) => ({ seq, issue_id, kind, fields, actor })), wanted);
    assert.equal(page.next_since, before + expected.length);
    assert.equal(await writerRows(), 0);
    log.push(...wanted);
  }
  async function silent(action: () => Promise<unknown>, code?: string): Promise<void> {
    const before = await latest();
    if (code === undefined) await action(); else await assert.rejects(action, { code });
    assert.equal(await latest(), before, code ? `rejected ${code} recorded no event` : 'the write recorded no event');
    assert.equal(await writerRows(), 0);
  }
  const create = (prefix: string, body: string, project = 'feed', actor = 'alice') => {
    const command = { op: 'create', prefix, request_id: crypto.randomUUID(), tool: 'feed', project, body };
    return { command, run: () => run(command, actor) };
  };
  const edge = (op: 'dependency_add' | 'dependency_remove', dependent_id: string, blocker_id: string, expected_revision: number) =>
    ({ op, dependent_id, blocker_id, expected_revision, request_id: crypto.randomUUID() });

  const first = create('cf', 'dependent');
  await records([['cf-1', 'created']], first.run);
  await records([['cf-2', 'created']], create('cf', 'first blocker').run);
  await records([['cf-3', 'created', [], 'bob']], create('cf', 'second blocker', 'other', 'bob').run);
  await silent(first.run);
  await silent(() => run({ ...first.command, request_id: crypto.randomUUID(), parent: 'cf-99' }), 'not_found');

  const firstEdge = edge('dependency_add', 'cf-1', 'cf-2', 1);
  await records([['cf-1', 'dependency_added']], () => run(firstEdge));
  await records([['cf-1', 'dependency_added']], () => run(edge('dependency_add', 'cf-1', 'cf-3', 2)));
  await silent(() => run(firstEdge));
  await silent(() => run(edge('dependency_add', 'cf-2', 'cf-1', 1)), 'dependency_cycle');
  await silent(() => run(edge('dependency_add', 'cf-1', 'cf-2', 1)), 'dependency_conflict');
  await silent(() => run(edge('dependency_add', 'cf-1', 'cf-2', 3)));
  await silent(() => run({ op: 'close', id: 'cf-1', expected: 1 }), 'dependency_blocked');

  await records([['cf-1', 'updated', ['body', 'priority']]], () => run({ op: 'update', id: 'cf-1', changes: [{ field: 'priority', value: 1, expected: 1 }, { field: 'body', value: 'dependent v2', expected: 1 }] }));
  await silent(() => run({ op: 'update', id: 'cf-1', changes: [{ field: 'body', value: 'stale', expected: 1 }] }), 'conflict');
  await records([['cf-1', 'updated', ['body']]], () => run({ op: 'update', id: 'cf-1', changes: [{ field: 'body', value: 'dependent v2', expected: 2 }] }));
  await records([['cf-2', 'status_changed', ['status', 'priority'], 'bob']], () => run({ op: 'update', id: 'cf-2', changes: [{ field: 'status', value: 'in_progress', expected: 1 }, { field: 'priority', value: 0, expected: 1 }] }, 'bob'));
  await records([['cf-2', 'status_changed', ['status'], 'bob']], () => run({ op: 'close', id: 'cf-2', expected: 2 }, 'bob'));

  const acquire = { op: 'claim_acquire', issue_id: 'cf-3', incarnation, session_id: bobSession, request_id: crypto.randomUUID(), ttl: 600 };
  let generation = 0;
  await records([['cf-3', 'claim_acquired', [], 'bob']], async () => {
    const result = await run(acquire, 'bob'); assert.ok('claim_receipt' in result); generation = result.claim_receipt.generation;
  });
  const claim_proof = { issue_id: 'cf-3', incarnation, session_id: bobSession, generation };
  await silent(() => run(acquire, 'bob'));
  await silent(() => run({ ...acquire, session_id: aliceSession, request_id: crypto.randomUUID() }), 'claim_conflict');
  await silent(() => run({ op: 'claim_renew', claim_proof, expected_revision: 1, request_id: crypto.randomUUID(), ttl: 600 }, 'bob'));
  await records([['cf-3', 'status_changed', ['status'], 'bob'], ['cf-1', 'became_ready', [], 'bob']], () => run({ op: 'close', id: 'cf-3', expected: 1, claim_proof }, 'bob'));
  await records([['cf-3', 'status_changed', ['status'], 'bob']], () => run({ op: 'close', id: 'cf-3', expected: 2, claim_proof }, 'bob'));
  const release = { op: 'claim_release', claim_proof, expected_revision: 2, request_id: crypto.randomUUID() };
  await records([['cf-3', 'claim_released', [], 'bob']], () => run(release, 'bob'));
  await silent(() => run(release, 'bob'));

  await records([['cf-1', 'commented']], () => run({ op: 'comment', id: 'cf-1', body: 'ready now' }));
  await silent(() => run({ op: 'comment', id: 'cf-99', body: 'missing' }), 'not_found');

  for (const [id, body] of [['cf-4', 'forced'], ['cf-5', 'open blocker'], ['cf-6', 'waits on forced']]) await records([[id, 'created']], create('cf', body).run);
  await records([['cf-4', 'dependency_added']], () => run(edge('dependency_add', 'cf-4', 'cf-5', 1)));
  await records([['cf-6', 'dependency_added']], () => run(edge('dependency_add', 'cf-6', 'cf-4', 1)));
  await records([['cf-6', 'dependency_added']], () => run(edge('dependency_add', 'cf-6', 'cf-2', 2)));
  await records([['cf-4', 'status_changed', ['status']], ['cf-6', 'became_ready'], ['cf-4', 'commented']], () => run({ op: 'close', id: 'cf-4', expected: 1, force: true, reason: 'Accepted exception' }));
  await records([['cf-6', 'dependency_removed']], () => run(edge('dependency_remove', 'cf-6', 'cf-2', 3)));
  await records([['cf-4', 'dependency_removed']], () => run(edge('dependency_remove', 'cf-4', 'cf-5', 2)));
  await silent(() => run(edge('dependency_remove', 'cf-4', 'cf-5', 3)));
  await records([['cf-4', 'status_changed', ['status']]], () => run({ op: 'reopen', id: 'cf-4', expected: 2 }));

  await records([['cf-7', 'created']], create('cf', 'loses its blocker').run);
  await records([['cf-7', 'dependency_added']], () => run(edge('dependency_add', 'cf-7', 'cf-5', 1)));
  await records([['cf-7', 'dependency_removed'], ['cf-7', 'became_ready']], () => run(edge('dependency_remove', 'cf-7', 'cf-5', 2)));
  for (const [id, body] of [['cf-8', 'shared blocker'], ['cf-9', 'first waiter'], ['cf-10', 'second waiter']]) await records([[id, 'created']], create('cf', body).run);
  await records([['cf-10', 'dependency_added']], () => run(edge('dependency_add', 'cf-10', 'cf-8', 1)));
  await records([['cf-9', 'dependency_added']], () => run(edge('dependency_add', 'cf-9', 'cf-8', 1)));
  await records([['cf-8', 'status_changed', ['status']], ['cf-9', 'became_ready'], ['cf-10', 'became_ready']], () => run({ op: 'close', id: 'cf-8', expected: 1 }));
  await records([['cf-7', 'updated', ['project', 'labels']]], () => run({ op: 'update', id: 'cf-7', changes: [{ field: 'labels', value: ['moved'], expected: 1 }, { field: 'project', value: 'other', expected: 1 }] }));

  const end = await latest();
  assert.deepEqual(log.map(change => change.seq), Array.from({ length: end }, (_, index) => index + 1));
  async function pages(filters: Record<string, unknown>, limit: number): Promise<number[]> {
    const seen: number[] = []; let since = 0;
    for (let reads = 0; reads <= end; reads++) {
      const page = await read({ ...filters, since, incarnation, limit });
      assert.ok(page.changes.length <= limit);
      seen.push(...page.changes.map(change => change.seq));
      if (page.next_since === end) return seen;
      assert.equal(page.changes.length, limit);
      assert.equal(page.next_since, page.changes.at(-1)?.seq);
      since = page.next_since;
    }
    return assert.fail('paging did not finish');
  }
  const filtered: [Record<string, unknown>, (change: LoggedChange) => boolean][] = [
    [{}, () => true],
    [{ project: 'other' }, change => change.issue_id === 'cf-3' || change.issue_id === 'cf-7'],
    [{ kinds: ['became_ready'] }, change => change.kind === 'became_ready'],
    [{ issue_ids: ['cf-4', 'cf-1'] }, change => change.issue_id === 'cf-1' || change.issue_id === 'cf-4'],
    [{ project: 'feed', kinds: ['status_changed', 'commented'] }, change => change.issue_id !== 'cf-3' && change.issue_id !== 'cf-7' && (change.kind === 'status_changed' || change.kind === 'commented')],
  ];
  for (const [filters, keep] of filtered) {
    const wanted = log.filter(keep).map(change => change.seq);
    for (const limit of [1, 2, 3, 7, end - 1, end, 100]) assert.deepEqual(await pages(filters, limit), wanted, `${JSON.stringify(filters)} with limit ${limit}`);
  }
  const page = await read({ since: 0, limit: 100 });
  assert.deepEqual(page.changes.map(({ seq, issue_id, kind, fields, actor }) => ({ seq, issue_id, kind, fields, actor })), log);
  assert.deepEqual(await read({ since: end, incarnation }), { incarnation, changes: [], next_since: end });

  await assert.rejects(read({ since: 1 }), { code: 'invalid_input', message: /incarnation is required/ });
  await assert.rejects(read({ since: end + 1, incarnation }), { code: 'invalid_input', status: 400, details: undefined });
  await assert.rejects(read({ since: 3, incarnation: otherIncarnation }), { code: 'incarnation_mismatch', status: 409, details: { incarnation, next_since: end } });
  await assert.rejects(read({ since: 0, incarnation: otherIncarnation }), { code: 'incarnation_mismatch', details: { incarnation, next_since: end } });

  const racing = await Promise.all(Array.from({ length: 4 }, () => create('race', 'concurrent').run()));
  assert.equal(racing.length, 4);
  const raced = await read({ since: end, incarnation, kinds: ['created'] });
  assert.deepEqual(raced.changes.map(change => change.seq), [end + 1, end + 2, end + 3, end + 4]);
  assert.deepEqual(raced.changes.map(change => change.issue_id).sort(), ['race-1', 'race-2', 'race-3', 'race-4']);

  const boundary = end + 4;
  await sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
    INSERT INTO change_events(issue_id, kind, fields_json, occurred_at, actor) SELECT 'cf-1', 'commented', '[]', unixepoch(), 'retention' FROM n`, CHANGE_RETENTION);
  const retained = (await sql('SELECT COUNT(*) AS count, MIN(seq) AS oldest, MAX(seq) AS newest FROM change_events'))[0];
  assert.deepEqual({ ...retained }, { count: CHANGE_RETENTION, oldest: boundary + 1, newest: boundary + CHANGE_RETENTION });
  assert.equal((await read({ since: boundary, incarnation, limit: 1 })).changes[0]?.seq, boundary + 1);
  await assert.rejects(read({ since: boundary - 1, incarnation }), { code: 'cursor_expired', status: 409, details: { incarnation, next_since: boundary + CHANGE_RETENTION } });
  await records([['cf-1', 'commented']], () => run({ op: 'comment', id: 'cf-1', body: 'pushes the window' }));
  await assert.rejects(read({ since: boundary, incarnation }), { code: 'cursor_expired', details: { incarnation, next_since: boundary + CHANGE_RETENTION + 1 } });
  await assert.rejects(read({ since: 0 }), { code: 'cursor_expired' });

  await sql(ROTATE_MEMORY_IDENTITY_SQL);
  const rotated = await read({ since: 0 });
  assert.notEqual(rotated.incarnation, incarnation);
  assert.deepEqual(rotated, { incarnation: rotated.incarnation, changes: [], next_since: 0 });
  await assert.rejects(read({ since: 5, incarnation }), { code: 'incarnation_mismatch', details: { incarnation: rotated.incarnation, next_since: 0 } });
  await run({ op: 'comment', id: 'cf-2', body: 'after rotation' });
  const restarted = await read({ since: 0, incarnation: rotated.incarnation });
  assert.deepEqual(restarted.changes.map(({ seq, issue_id, kind }) => ({ seq, issue_id, kind })), [{ seq: 1, issue_id: 'cf-2', kind: 'commented' }]);
  return log;
}
