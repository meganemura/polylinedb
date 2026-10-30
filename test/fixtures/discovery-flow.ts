// Runs discovery links on one store: create with a link, both directions on show, the refusals, the replay rule, and the schema 12 upgrade.
// Local SQLite and workerd D1 run the same flows.
import assert from 'node:assert/strict';
import { executeOperation, parseOperation } from '../../src/records/index.ts';
import { PolylinedbError } from '../../src/records/store/errors.ts';
import type { Actor } from '../../src/records/index.ts';
import type { SqlExecutor } from '../../src/records/persistence/persistence.ts';

type Row = Record<string, unknown>;

const owner: Actor = { id: 'access:owner', kind: 'human' };
const agent: Actor = { id: 'service:scout', kind: 'agent' };

function helpers(db: SqlExecutor) {
  const run = async (value: unknown, actor: Actor = owner): Promise<Row> => await executeOperation(db, parseOperation(value), actor) as Row;
  const sql = async (statement: string, ...params: (string | number | null)[]) => ((await db.batch([{ sql: statement, params }]))[0]?.rows ?? []).map(row => ({ ...row }));
  const refusal = async (pending: Promise<unknown>) => {
    try { await pending; } catch (error) {
      assert.ok(error instanceof PolylinedbError, String(error));
      return { code: error.code, details: error.details };
    }
    return assert.fail('The write was accepted');
  };
  const idOf = (result: Row) => (result.issue as Row & { id: string }).id;
  const links = async (id: string) => { const shown = await run({ op: 'show', id }); return { discovered_from: shown.discovered_from, discovered: shown.discovered }; };
  return { run, sql, refusal, idOf, links };
}

const create = (body: string, extra: Row = {}): Row => ({ op: 'create', prefix: 'df', request_id: crypto.randomUUID(), tool: 'test', project: 'discovery', body, labels: ['ready'], ...extra });

export async function runDiscoveryFlow(db: SqlExecutor): Promise<void> {
  const { run, sql, refusal, idOf, links } = helpers(db);
  const source = idOf(await run(create('Migrate the parser')));
  assert.deepEqual(await links(source), { discovered_from: null, discovered: [] }, 'an issue with no links shows none');

  // An agent files what it finds mid-work, with or without a claim on the source.
  const firstRequest = create('The lexer drops a trailing newline', { discovered_from: source });
  const first = idOf(await run(firstRequest, agent));
  const second = idOf(await run(create('The parser test is flaky', { discovered_from: source })));
  assert.deepEqual(await links(first), { discovered_from: source, discovered: [] });
  assert.deepEqual(await links(source), { discovered_from: null, discovered: [first, second] }, 'the source lists what was found, in issue order');
  const deeper = idOf(await run(create('The newline fix needs a fixture', { discovered_from: first })));
  assert.deepEqual(await links(first), { discovered_from: source, discovered: [deeper] }, 'one issue can be found from and lead to others');

  // The source must exist, and a refused create files nothing.
  const issuesBefore = await sql('SELECT count(*) AS n FROM issues');
  const missing = await refusal(run(create('Found nowhere', { discovered_from: 'df-999' })));
  assert.deepEqual(missing, { code: 'not_found', details: { id: 'df-999' } });
  assert.deepEqual(await sql('SELECT count(*) AS n FROM issues'), issuesBefore);
  assert.equal((await refusal(run(create('Bad source', { discovered_from: 'not an id' })))).code, 'invalid_input');

  // A retry with the same request returns the same issue and keeps one link; a different or missing link is a different request.
  assert.equal(idOf(await run(firstRequest, agent)), first);
  assert.deepEqual(await sql('SELECT issue_id, discovered_from FROM issue_discoveries WHERE issue_id = ?', first), [{ issue_id: first, discovered_from: source }]);
  assert.equal((await refusal(run({ ...firstRequest, discovered_from: second }, agent))).code, 'request_conflict');
  const { discovered_from: _, ...unlinked } = firstRequest;
  assert.equal((await refusal(run(unlinked, agent))).code, 'request_conflict');
  const plainRequest = create('Filed without a link');
  const plain = idOf(await run(plainRequest));
  assert.equal((await refusal(run({ ...plainRequest, discovered_from: source }))).code, 'request_conflict', 'a link cannot be added by replaying a create');
  assert.deepEqual(await links(plain), { discovered_from: null, discovered: [] });

  // The link never holds anything: both ends stay ready, claimable, and closable.
  const ready = await run({ op: 'dependency_worklist', state: 'ready', project: 'discovery' });
  assert.deepEqual((ready.issues as Row[]).map(issue => issue.id), [source, first, second, deeper, plain]);
  const observed = (await run({ op: 'claim_show', issue_id: first })).claim as Row;
  const acquired = await run({ op: 'claim_acquire', issue_id: first, incarnation: observed.store_incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID() }, agent);
  assert.deepEqual(acquired.open_blockers, []);
  const sourceIssue = (await run({ op: 'show', id: source })).issue as Row & { versions: { status: number } };
  assert.equal(((await run({ op: 'close', id: source, expected: sourceIssue.versions.status })).issue as Row).status, 'closed', 'the source closes while what it found is open');
  const secondIssue = (await run({ op: 'show', id: second })).issue as Row & { versions: { status: number } };
  assert.equal(((await run({ op: 'close', id: second, expected: secondIssue.versions.status })).issue as Row).status, 'closed');
  assert.deepEqual(await links(source), { discovered_from: null, discovered: [first, second] }, 'closing either end keeps the link');
}

/** Writes one issue on a schema 12 store, before discovery links existed. */
export async function populateSchema12Discovery(db: SqlExecutor): Promise<{ id: string }> {
  const { run, idOf } = helpers(db);
  return { id: idOf(await run(create('Filed before links'))) };
}

/** Checks a store that upgraded from schema 12: the old issue has no links and can be the source of a new one. */
export async function checkSchema12Discovery(db: SqlExecutor, populated: { id: string }): Promise<void> {
  const { run, idOf, links } = helpers(db);
  assert.deepEqual(await links(populated.id), { discovered_from: null, discovered: [] });
  const found = idOf(await run(create('Found after the upgrade', { discovered_from: populated.id })));
  assert.deepEqual(await links(populated.id), { discovered_from: null, discovered: [found] });
  assert.deepEqual(await links(found), { discovered_from: populated.id, discovered: [] });
}
