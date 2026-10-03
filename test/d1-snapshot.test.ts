// Checks cf process boundaries without cloud credentials or a remote database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cfQuery, parseQueryOutput, parseTarget } from '../scripts/d1-snapshot.ts';

const target = parseTarget({ profile: 'migration', accountId: 'a'.repeat(32), databaseId: '11111111-1111-4111-8111-111111111111', snapshotSha256: 'b'.repeat(64), schemaVersion: 3 });

test('cf transport fixes identity, protects bound values, cleans files, and sanitizes failures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pd-cf-test-'));
  const bin = join(directory, 'bin'); mkdirSync(bin);
  const capture = join(directory, 'capture.json');
  const original = { PATH: process.env.PATH, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN, PD_TEST_CAPTURE: process.env.PD_TEST_CAPTURE, PD_TEST_FAIL: process.env.PD_TEST_FAIL };
  writeFileSync(join(bin, 'cf'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const path = args[args.indexOf('--batch') + 1].slice(1);
fs.writeFileSync(process.env.PD_TEST_CAPTURE, JSON.stringify({ args, path, body: JSON.parse(fs.readFileSync(path, 'utf8')), mode: fs.statSync(path).mode & 511, account: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN }));
if (process.env.PD_TEST_FAIL) { process.stderr.write('secret-token private SQL'); process.exit(1); }
process.stdout.write(JSON.stringify({ success: true, result: [{ success: true, results: [{ answer: 42 }] }] }));
`, { mode: 0o700 });
  try {
    process.env.PATH = `${bin}:${original.PATH}`;
    process.env.CLOUDFLARE_API_TOKEN = 'ambient-token';
    process.env.PD_TEST_CAPTURE = capture;
    delete process.env.PD_TEST_FAIL;
    const statement = { sql: 'SELECT ? AS value', params: ['quote\' NUL\0 日本語'] };
    assert.deepEqual(await cfQuery(target)(statement), [{ answer: 42 }]);
    const captured = JSON.parse(readFileSync(capture, 'utf8'));
    assert.deepEqual(captured.args.slice(0, 5), ['d1', 'query', target.databaseId, '--profile', target.profile]);
    assert.equal(captured.account, target.accountId);
    assert.equal(captured.token, undefined);
    assert.equal(captured.mode, 0o600);
    assert.deepEqual(captured.body, [statement]);
    assert.equal(existsSync(captured.path), false);
    process.env.PD_TEST_FAIL = '1';
    await assert.rejects(cfQuery(target)(statement), { message: 'cf query failed; the destination may contain a resumable partial import' });
    assert.equal(existsSync(JSON.parse(readFileSync(capture, 'utf8')).path), false);
  } finally {
    for (const [name, value] of Object.entries(original)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cf envelopes fail closed and targets reject ambiguous extra fields', () => {
  for (const value of [null, {}, { success: false, result: [] }, [{ success: false, results: [] }], [], [{ success: true, results: [null] }]]) assert.throws(() => parseQueryOutput(value));
  assert.throws(() => parseTarget({ ...target, account: 'other' }));
  assert.throws(() => parseTarget({ ...target, profile: '--other' + '\n' }));
});

test('verify CLI exports the checked remote snapshot privately and refuses overwrite', async () => {
  const { spawnSync } = await import('node:child_process');
  const { createHash, randomUUID } = await import('node:crypto');
  const { statSync } = await import('node:fs');
  const { initializeStore, openStore } = await import('../src/sqlite.ts');
  const { executeOperation, parseOperation } = await import('../src/issues.ts');
  const { canonicalSnapshot } = await import('../src/snapshot.ts');
  const directory = mkdtempSync(join(tmpdir(), 'pd-verify-cli-'));
  const location = { directory: join(directory, 'database') };
  const { database_path } = initializeStore(location);
  const store = openStore(location);
  try {
    await executeOperation(store.db, parseOperation({ op: 'create', prefix: 'pd', request_id: randomUUID(), tool: 'fixture', project: 'test', body: 'Remote export 日本語' }), 'test:export');
    const canonical = canonicalSnapshot(store.exportSnapshot());
    const bin = join(directory, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'cf'), `#!/usr/bin/env node
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const args = process.argv.slice(2);
const [statement] = JSON.parse(fs.readFileSync(args[args.indexOf('--batch') + 1].slice(1), 'utf8'));
const database = new DatabaseSync(process.env.PD_TEST_DATABASE, { readOnly: true });
try { process.stdout.write(JSON.stringify({ success: true, result: [{ success: true, results: database.prepare(statement.sql).all(...statement.params) }] })); }
finally { database.close(); }
`, { mode: 0o700 });
    const snapshot = join(directory, 'snapshot.json');
    const targetFile = join(directory, 'target.json');
    const output = join(directory, 'verified.json');
    writeFileSync(snapshot, canonical, { mode: 0o600 });
    writeFileSync(targetFile, JSON.stringify({ ...target, snapshotSha256: createHash('sha256').update(canonical).digest('hex') }), { mode: 0o600 });
    const run = (outputPath: string) => spawnSync(process.execPath, ['scripts/d1-snapshot.ts', 'verify', '--snapshot', snapshot, '--target', targetFile, '--output', outputPath], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PD_TEST_DATABASE: database_path }, encoding: 'utf8',
    });
    const first = run(output);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).result, 'verified');
    assert.equal('snapshot' in JSON.parse(first.stdout), false);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(readFileSync(output, 'utf8'), canonical + '\n');
    assert.equal(run(output).status, 1);
    assert.equal(readFileSync(output, 'utf8'), canonical + '\n');
    assert.equal(run('relative.json').status, 1);
    await store.db.batch([{ sql: "UPDATE issues SET body = 'changed remotely'", params: [] }]);
    const mismatchedOutput = join(directory, 'mismatched.json');
    assert.equal(run(mismatchedOutput).status, 1);
    assert.equal(existsSync(mismatchedOutput), false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
