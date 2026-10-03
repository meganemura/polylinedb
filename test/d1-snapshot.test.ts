// Checks cf process boundaries without cloud credentials or a remote database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cfQuery, parseQueryOutput, parseTarget } from '../scripts/d1-snapshot.ts';

const target = parseTarget({ profile: 'migration', accountId: 'a'.repeat(32), databaseId: '11111111-1111-4111-8111-111111111111', snapshotSha256: 'b'.repeat(64), schemaVersion: 2 });

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
