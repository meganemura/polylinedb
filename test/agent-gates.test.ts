// Checks the agent gates through the shared operation entry and the CLI; human actors keep the cooperative contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeStore, openStore } from '../src/local-store/index.ts';
import { executeOperation, parseOperation } from '../src/records/index.ts';
import { admitAgentWrite } from '../src/transition/index.ts';
import { runGateRaces } from './fixtures/gate-races.ts';
import { runMainLockFlow } from './fixtures/main-lock-flow.ts';

const session = '00000000-0000-4000-8000-0000000000c1';
const codex = { id: 'local:codex', kind: 'agent' } as const;
const claude = { id: 'local:claude', kind: 'agent' } as const;
const human = 'local:rocky-human';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pd-gates-'));
  const cwd = join(root, 'work'); const directory = join(root, 'store'); mkdirSync(cwd);
  initializeStore({ directory, cwd });
  const store = openStore({ directory, cwd });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const run = (value: unknown, actor: string | { id: string; kind: 'human' | 'agent' } = human) => executeOperation(store.db, parseOperation(value), actor);
  const create = async (labels: string[] = []) => {
    const result = await run({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'gate', project: 'gate', body: 'work', labels });
    assert.ok('issue' in result); return result.issue.id;
  };
  const incarnation = async () => {
    const result = await run({ op: 'claim_show', issue_id: 'pd-1' });
    assert.ok('claim' in result); return result.claim.store_incarnation;
  };
  const acquire = async (issue_id: string, actor: Parameters<typeof run>[1]) => {
    const result = await run({ op: 'claim_acquire', issue_id, incarnation: await incarnation(), session_id: session, request_id: crypto.randomUUID(), ttl: 300 }, actor);
    assert.ok('claim_receipt' in result); return result.claim_receipt;
  };
  return { run, create, acquire, incarnation };
}

test('an agent cannot claim an issue without the ready label', async t => {
  const { run, create, acquire, incarnation } = fixture(t);
  const plain = await create();
  await assert.rejects(run({ op: 'claim_acquire', issue_id: plain, incarnation: await incarnation(), session_id: session, request_id: crypto.randomUUID(), ttl: 300 }, codex),
    { code: 'not_ready', status: 409, details: { id: plain } });
  const ready = await create(['ready']);
  assert.equal((await acquire(ready, codex)).actor, 'local:codex');
});

test('an agent write without its own active claim fails at entry and leaves the issue unchanged', async t => {
  const { run, create, acquire } = fixture(t);
  const id = await create(['ready']);
  const blocker = await create();
  const writes = [
    { op: 'update', id, changes: [{ field: 'body', value: 'agent edit', expected: 1 }] },
    { op: 'close', id, expected: 1 },
    { op: 'reopen', id, expected: 1 },
    { op: 'comment', id, body: 'note' },
    { op: 'dependency_add', dependent_id: id, blocker_id: blocker, expected_revision: 1, request_id: crypto.randomUUID() },
    { op: 'dependency_remove', dependent_id: id, blocker_id: blocker, expected_revision: 1, request_id: crypto.randomUUID() },
  ];
  for (const write of writes) await assert.rejects(run(write, codex), { code: 'claim_required', status: 409, details: { id } }, write.op);
  await acquire(id, claude);
  for (const write of writes) await assert.rejects(run(write, codex), { code: 'claim_required' }, `${write.op} by the wrong holder`);
  const shown = await run({ op: 'show', id });
  assert.ok('comments' in shown);
  assert.deepEqual([shown.issue.body, shown.issue.versions.body, shown.comments.length], ['work', 1, 0]);
});

test('the holding agent writes, and release ends its permission', async t => {
  const { run, create, acquire } = fixture(t);
  const id = await create(['ready']);
  const receipt = await acquire(id, codex);
  const updated = await run({ op: 'update', id, changes: [{ field: 'body', value: 'agent edit', expected: 1 }] }, codex);
  assert.ok('issue' in updated); assert.equal(updated.issue.body, 'agent edit');
  assert.ok('comment' in await run({ op: 'comment', id, body: 'progress' }, codex));
  const proof = { issue_id: id, incarnation: receipt.incarnation, session_id: session, generation: receipt.generation };
  await run({ op: 'claim_release', claim_proof: proof, expected_revision: receipt.revision, request_id: crypto.randomUUID() }, codex);
  await assert.rejects(run({ op: 'comment', id, body: 'after release' }, codex), { code: 'claim_required' });
});

test('a human claims and edits an issue without the ready label', async t => {
  const { run, create, acquire } = fixture(t);
  const id = await create();
  assert.equal((await acquire(id, human)).actor, human);
  assert.ok('comment' in await run({ op: 'comment', id, body: 'mid-edit' }));
  const other = await create(['ready']);
  const edited = await run({ op: 'update', id: other, changes: [{ field: 'labels', value: [], expected: 1 }] });
  assert.ok('issue' in edited); assert.deepEqual(edited.issue.labels, []);
});

test('an agent reads only labeled issues from the ready worklist', async t => {
  const { run, create } = fixture(t);
  await create(); const ready = await create(['ready', 'p']); await create(['p']);
  const worklist = await run({ op: 'dependency_worklist', state: 'ready' }, codex);
  assert.ok('issues' in worklist); assert.deepEqual(worklist.issues.map(issue => issue.id), [ready]);
  await assert.rejects(run({ op: 'dependency_worklist', state: 'ready', label: 'p' }, codex), { code: 'invalid_input' });
  const all = await run({ op: 'dependency_worklist', state: 'ready' });
  assert.ok('issues' in all); assert.equal(all.issues.length, 3);
});

test('an expired lease no longer admits the agent', () => {
  const claim = { incarnation: 'a'.repeat(32), actor: 'local:codex', session_id: session, generation: 1, revision: 1, expires_at: 100, released_at: null };
  const observed = { labels: ['ready'], claim, store_incarnation: 'a'.repeat(32) };
  assert.deepEqual(admitAgentWrite(codex, 'issue_write', { ...observed, now: 99 }), { admitted: true });
  assert.deepEqual(admitAgentWrite(codex, 'issue_write', { ...observed, now: 100 }), { admitted: false, code: 'claim_required' });
  assert.deepEqual(admitAgentWrite({ id: 'local:codex', kind: 'human' }, 'claim_acquire', { ...observed, labels: [], now: 99 }), { admitted: true });
});

test('the CLI reads the actor kind from the flag or the environment', t => {
  const root = mkdtempSync(join(tmpdir(), 'pd-gates-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'work'); const directory = join(root, 'store'); mkdirSync(cwd);
  initializeStore({ directory, cwd });
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(root, 'config-home') };
  for (const name of ['POLYLINEDB_ACTOR', 'POLYLINEDB_ACTOR_KIND', 'POLYLINEDB_DATA_DIR', 'POLYLINEDB_CONNECTION', 'POLYLINEDB_SESSION_ID']) delete env[name];
  const pd = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), '--data-dir', directory, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
    return { status: result.status, output: JSON.parse(result.stdout || result.stderr) };
  };
  assert.equal(pd(['--actor', 'local:rocky', 'create', '--tool', 'gate', '--project', 'gate', '--body', 'work']).status, 0);
  assert.equal(pd(['--actor', 'local:codex', '--actor-kind', 'agent', 'comment', 'pd-1', '--body', 'x']).output.error.code, 'claim_required');
  assert.equal(pd(['--actor', 'local:codex', 'comment', 'pd-1', '--body', 'x'], { POLYLINEDB_ACTOR_KIND: 'agent' }).output.error.code, 'claim_required');
  assert.equal(pd(['--actor', 'local:codex', '--actor-kind', 'robot', 'comment', 'pd-1', '--body', 'x']).output.error.code, 'invalid_input');
  assert.ok('comment' in pd(['--actor', 'local:rocky', 'comment', 'pd-1', '--body', 'x']).output);
});

test('two local agents claim different issues under their own actors and never under the shared repository actor', t => {
  const root = mkdtempSync(join(tmpdir(), 'pd-actors-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo'); const directory = join(root, 'store'); mkdirSync(cwd);
  execFileSync('git', ['init', '-q'], { cwd });
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(root, 'config-home') };
  for (const name of ['POLYLINEDB_ACTOR', 'POLYLINEDB_ACTOR_KIND', 'POLYLINEDB_DATA_DIR', 'POLYLINEDB_CONNECTION', 'POLYLINEDB_SESSION_ID']) delete env[name];
  const pd = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'src', 'cli.ts'), ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
    return JSON.parse(result.stdout || result.stderr);
  };
  assert.ok(pd(['--data-dir', directory, 'init', '--tool', 'gate', '--project', 'gate', '--actor', 'local:shared']).database_path);
  for (const body of ['one', 'two']) assert.ok(pd(['create', '--body', body, '--label', 'ready']).issue);
  const incarnation = pd(['claim', 'show', 'pd-1']).claim.store_incarnation;
  const agent = (actor: string) => ({ POLYLINEDB_ACTOR: actor, POLYLINEDB_ACTOR_KIND: 'agent', POLYLINEDB_SESSION_ID: crypto.randomUUID() });
  const codex = pd(['claim', 'acquire', 'pd-1', '--incarnation', incarnation, '--agent-label', 'Codex', '--request-id', crypto.randomUUID()], agent('local:codex'));
  const claude = pd(['claim', 'acquire', 'pd-2', '--incarnation', incarnation, '--agent-label', 'Claude', '--request-id', crypto.randomUUID()], agent('local:claude'));
  assert.deepEqual([codex.claim_receipt.actor, claude.claim_receipt.actor], ['local:codex', 'local:claude']);
  assert.deepEqual(pd(['claim', 'list']).claims.map((claim: { lease: { actor: string } }) => claim.lease.actor), ['local:codex', 'local:claude']);
  assert.equal(pd(['--actor-kind', 'agent', 'claim', 'show', 'pd-1']).error.code, 'invalid_input');
  assert.equal(pd(['comment', 'pd-2', '--body', 'x'], agent('local:codex')).error.code, 'claim_required');
});

test('a change between the gate and the write cannot let an agent write land on SQLite', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pd-races-'));
  const cwd = join(root, 'work'); const directory = join(root, 'store'); mkdirSync(cwd);
  initializeStore({ directory, cwd });
  const store = openStore({ directory, cwd });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  assert.equal((await runGateRaces(store.db, 'r')).length, 10);
});

test('the main-lock issue stays out of the ready worklist and admits one agent at a time on SQLite', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pd-lock-'));
  const cwd = join(root, 'work'); const directory = join(root, 'store'); mkdirSync(cwd);
  initializeStore({ directory, cwd });
  const store = openStore({ directory, cwd });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  await runMainLockFlow(store.db);
});
