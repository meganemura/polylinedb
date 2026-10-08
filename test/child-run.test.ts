// Verifies the test child runner's results and both of its limits with real processes.
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { childLimits, childStarted, runChild } from './fixtures/child-run.ts';

const node = (code: string) => ['--import', childStarted, '-e', code];
const options = { cwd: tmpdir(), env: process.env };

test('a child result carries its status, output, and input', async () => {
  const echoed = await runChild('echo', process.execPath, node('process.stdin.pipe(process.stdout); process.stderr.write("note")'),
    { ...options, input: 'given input' });
  assert.deepEqual(echoed, { status: 0, signal: null, stdout: 'given input', stderr: 'note' });
  assert.equal((await runChild('exit', process.execPath, node('process.exit(3)'), options)).status, 3);
});

test('a child that started and hangs fails with its run time and CPU time', async () => {
  await assert.rejects(runChild('hang', process.execPath, node('setInterval(() => {}, 1000)'),
    { ...options, limits: { startMs: childLimits.startMs, runMs: 500 } }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^hang did not exit within 500 ms after it started: pid \d+, child CPU \S+, started \d+ ms after spawn, \d+ ms in total$/);
    return true;
  });
});

test('a child that never starts fails with the start limit', async () => {
  await assert.rejects(runChild('sleeper', 'sleep', ['30'], { ...options, limits: { startMs: 300, runMs: childLimits.runMs } }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^sleeper did not start within 300 ms: pid \d+, child CPU \S+$/);
    return true;
  });
});

test('the run limit excludes the wait before the child starts', async () => {
  const delayed = await runChild('delayed', '/bin/sh', ['-c', 'sleep 2; exec "$0" "$@"', process.execPath, ...node('process.stdout.write("ran")')],
    { ...options, limits: { startMs: childLimits.startMs, runMs: 1500 } });
  assert.deepEqual(delayed, { status: 0, signal: null, stdout: 'ran', stderr: '' });
});
