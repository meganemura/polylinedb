// Drives the restored-addition command through injected ports; no test spawns cf or reaches a Cloudflare resource.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { d1Results, parseArguments, readPlan, restoredAdditionCommand, usage, type Plan } from '../scripts/d1-restored-addition-command.ts';
import { AdditionRefused } from '../scripts/d1-restored-addition.ts';
import { readConnections } from '../src/workspace/index.ts';
import { localStore, privateDirectory, restoredDestination, routingEnvironment, sqliteBatch } from './fixtures/restored-addition.ts';

const refusal = (pattern: RegExp) => (error: unknown) => error instanceof AdditionRefused && pattern.test(error.message);

async function fixture(context: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pd-restored-command-')));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { original, destination } = await restoredDestination(root);
  context.after(() => destination.close());
  const source = await localStore(root, 'source', 'src');
  source.store.close();
  const environment = routingEnvironment(root, source.path);
  const plan: Plan = {
    profile: 'review', accountId: 'a'.repeat(32), databaseId: '00000000-0000-4000-8000-000000000000', connection: 'cloud', url: 'https://issues.example.invalid',
    original, source: source.path, journal: privateDirectory(root, 'journal'), repositories: [],
  };
  const write = (value: unknown, name = 'plan.json') => {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  };
  const planned: Plan[] = [];
  const ports = { environment, batch: (selected: Plan) => { planned.push(selected); return sqliteBatch(destination); } };
  return { root, plan, write, ports, planned, environment, destination, source: source.path };
}

test('the command runs, resumes, and reports the owner outcome through the injected batch port', async context => {
  const f = await fixture(context);
  const path = f.write(f.plan);
  const result = await restoredAdditionCommand(['--plan', path, '--run'], f.ports);
  assert.equal(result.outcome, 'routed');
  assert.deepEqual(f.planned, [f.plan]);
  assert.equal(readConnections(f.environment).defaultName, 'cloud');
  assert.deepEqual(await restoredAdditionCommand(['--plan', path, '--resume'], f.ports), result);
  assert.deepEqual(await restoredAdditionCommand(['--plan', path, '--resume', '--accept-destination-edits'], f.ports), result);
  await assert.rejects(restoredAdditionCommand(['--plan', path, '--release-source'], f.ports), refusal(/addition committed; the source stays retired/));
  assert.equal(f.destination.prepare("SELECT COUNT(*) AS n FROM issues WHERE id LIKE 'src-%'").get()?.n, 2);
});

test('the command refuses a plan URL that differs from the cloud connection before it builds the batch port', async context => {
  const f = await fixture(context);
  const path = f.write({ ...f.plan, url: 'https://elsewhere.example.invalid' });
  await assert.rejects(restoredAdditionCommand(['--plan', path, '--run'], f.ports), refusal(/plan URL differs from the cloud connection/));
  assert.deepEqual(f.planned, []);
  const source = new DatabaseSync(f.source);
  context.after(() => source.close());
  assert.equal(source.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'polylinedb_retired_%'").get()?.n, 0);
});

test('the command accepts only its documented arguments', () => {
  assert.deepEqual(parseArguments(['--plan', '/plan.json', '--run']), { plan: '/plan.json', action: 'run' });
  assert.deepEqual(parseArguments(['--plan', '/plan.json', '--resume']), { plan: '/plan.json', action: 'resume' });
  assert.deepEqual(parseArguments(['--plan', '/plan.json', '--resume', '--accept-destination-edits']), { plan: '/plan.json', action: 'resume-accepting-destination-edits' });
  assert.deepEqual(parseArguments(['--plan', '/plan.json', '--release-source']), { plan: '/plan.json', action: 'release-source' });
  for (const argv of [[], ['--plan', 'plan.json', '--run'], ['--plan', '/plan.json'], ['--plan', '/plan.json', '--run', '--resume'], ['--plan', '/plan.json', '--accept-destination-edits', '--resume'], ['--run', '--plan', '/plan.json']]) {
    assert.throws(() => parseArguments(argv), (error: unknown) => error instanceof AdditionRefused && error.message === usage, argv.join(' '));
  }
});

test('the plan must be a private file with exact, valid fields', async context => {
  const f = await fixture(context);
  assert.deepEqual(readPlan(f.write(f.plan)), f.plan);
  assert.deepEqual(readPlan(f.write({ ...f.plan, maximumStatements: 50 })), { ...f.plan, maximumStatements: 50 });
  const shared = f.write(f.plan, 'shared.json');
  chmodSync(shared, 0o644);
  assert.throws(() => readPlan(shared), refusal(/private regular file/));
  const cases: [unknown, RegExp][] = [
    [{ ...f.plan, extra: 1 }, /Unexpected plan fields/],
    [{ ...f.plan, accountId: 'A'.repeat(32) }, /accountId is invalid/],
    [{ ...f.plan, databaseId: 'production' }, /databaseId is invalid/],
    [{ ...f.plan, url: 'http://issues.example.invalid' }, /url is invalid/],
    [{ ...f.plan, journal: 'journal' }, /paths must be absolute/],
    [{ ...f.plan, repositories: ['relative'] }, /repositories must be absolute/],
    [{ ...f.plan, maximumStatements: 1.5 }, /statement limit must be an integer/],
    [[], /Unexpected plan fields/],
  ];
  for (const [value, pattern] of cases) assert.throws(() => readPlan(f.write(value, 'case.json')), refusal(pattern), String(pattern));
  writeFileSync(join(f.root, 'case.json'), '{');
  assert.throws(() => readPlan(join(f.root, 'case.json')), refusal(/not JSON/));
});

test('cf output parsing accepts both result shapes and rejects any failed or missing statement', () => {
  const rows = [{ success: true, results: [{ n: 1 }] }, { success: true, results: [] }];
  assert.deepEqual(d1Results(rows, 2), [[{ n: 1 }], []]);
  assert.deepEqual(d1Results({ result: rows }, 2), [[{ n: 1 }], []]);
  assert.throws(() => d1Results(rows, 3), /Unexpected D1 batch result/);
  assert.throws(() => d1Results({ errors: [] }, 0), /Unexpected D1 batch result/);
  assert.throws(() => d1Results([{ success: false, results: [] }], 1), /D1 statement failed/);
  assert.throws(() => d1Results([{ success: true }], 1), /D1 statement failed/);
});
