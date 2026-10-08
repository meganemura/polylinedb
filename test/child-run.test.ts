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

test('a child that started and hangs fails with its run time, CPU time, and descendants', async () => {
  // The start signal waits for the descendant's exec, so the run limit cannot stop the child before it exists.
  const hang = 'require("node:child_process").spawn("sleep", ["30"], { stdio: "ignore" })'
    + '.once("spawn", () => require("node:fs").writeSync(3, "started")); setInterval(() => {}, 1000)';
  await assert.rejects(runChild('hang', process.execPath, ['-e', hang], { ...options, limits: { startMs: childLimits.startMs, runMs: 500 } }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^hang did not exit within 500 ms after it started: pid \d+, child CPU \S+, started \d+ ms after spawn, \d+ ms in total, timer -?\d+ ms late, descendants: \d+ \S+ CPU \S+ RSS \d+ KiB \S*sleep$/);
    return true;
  });
});

test('a child that never starts fails with the start limit', async () => {
  await assert.rejects(runChild('sleeper', 'sleep', ['30'], { ...options, limits: { startMs: 300, runMs: childLimits.runMs } }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^sleeper did not start within 300 ms: pid \d+, child CPU \S+, timer -?\d+ ms late$/);
    return true;
  });
});

test('the run limit excludes the wait before the child starts', async () => {
  const delayed = await runChild('delayed', '/bin/sh', ['-c', 'sleep 2; exec "$0" "$@"', process.execPath, ...node('process.stdout.write("ran")')],
    { ...options, limits: { startMs: childLimits.startMs, runMs: 1500 } });
  assert.deepEqual(delayed, { status: 0, signal: null, stdout: 'ran', stderr: '' });
});
