// Subprocesses drive `pd claim keepalive` against a real local SQLite store, the way users call it.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import { defaultMaxDurationSeconds, maximumMaxDurationSeconds, renewalDelayMs } from '../src/cli-keepalive.ts';

const executable = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

function lane(t: TestContext, labels: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'polylinedb-keepalive-'));
  const cwd = join(root, 'work');
  const directory = join(root, 'store');
  mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(root, 'config-home') };
  for (const name of ['POLYLINEDB_ACTOR', 'POLYLINEDB_ACTOR_KIND', 'POLYLINEDB_DATA_DIR', 'POLYLINEDB_CONNECTION', 'POLYLINEDB_SESSION_ID']) delete env[name];
  const args = (rest: readonly string[]) => [executable, '--data-dir', directory, '--actor', 'local:keepalive', ...rest];
  function run(rest: string[], status = 0) {
    const result = spawnSync(process.execPath, args(rest), { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, status, result.stderr);
    return JSON.parse(status === 0 ? result.stdout : result.stderr);
  }
  function keepalive(rest: readonly string[]) {
    const child = spawn(process.execPath, args(['claim', 'keepalive', ...rest]), { cwd, env });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const finished = new Promise<{ status: number | null; error: { code: string } | undefined }>((resolve, reject) => {
      child.on('error', reject);
      // An orphaned command holds the inherited pipes open, so wait on exit rather than close.
      child.on('exit', status => {
        setTimeout(() => {
          const line = stderr.split('\n').find(text => text.startsWith('{"error"'));
          resolve({ status, error: line === undefined ? undefined : JSON.parse(line).error });
        }, 300);
      });
    });
    return finished;
  }
  run(['init']);
  run(['create', '--tool', 'test', '--project', 'test', '--body', 'Long checks', ...labels.flatMap(label => ['--label', label])]);
  const session = crypto.randomUUID();
  const incarnation = run(['claim', 'show', '1']).claim.store_incarnation as string;
  const acquire = (ttl: string) => run(['claim', 'acquire', '1', '--incarnation', incarnation, '--session-id', session, '--ttl', ttl]).claim_receipt;
  const claim = () => run(['claim', 'show', '1']).claim;
  const waitForRevision = async (revision: number) => {
    for (let attempt = 0; attempt < 100 && claim().lease.revision < revision; attempt++) await delay(100);
    assert.ok(claim().lease.revision >= revision, `revision reached ${revision}`);
  };
  const release = (receipt: object) => {
    for (let attempt = 0; ; attempt++) {
      const result = spawnSync(process.execPath, args(['claim', 'release', '--claim-proof', JSON.stringify(receipt), '--expected-revision', String(claim().lease.revision)]), { cwd, env, encoding: 'utf8' });
      if (result.status === 0) break;
      assert.ok(attempt < 5 && result.status === 4, result.stderr);
    }
  };
  const reacquire = (receipt: object, ttl: string) => { release(receipt); return acquire(ttl); };
  return { directory, run, keepalive, acquire, release, claim, waitForRevision, reacquire, root };
}
const sleeper = (seconds: number) => ['node', '-e', `setTimeout(() => process.exit(0), ${seconds * 1000})`];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('pd claim keepalive', { concurrency: true }, () => {
  test('renews on schedule and exits with the command exit code', async (t: TestContext) => {
    const { acquire, claim, keepalive } = lane(t);
    const receipt = acquire('30');
    const finished = await keepalive(['--claim-proof', JSON.stringify(receipt), '--ttl', '30', '--', 'node', '-e', 'setTimeout(() => process.exit(3), 25000)']);
    assert.equal(finished.status, 3);
    assert.equal(finished.error, undefined);
    const after = claim();
    assert.equal(after.state, 'active');
    assert.equal(after.lease.generation, receipt.generation);
    assert.equal(after.lease.session_id, receipt.session_id);
    assert.equal(after.lease.revision, 3);
    assert.equal(after.lease.expires_at - after.lease.changed_at, 30);
  });

  for (const kill of [false, true]) test(`stops with claim_lost when the claim is reacquired, ${kill ? 'killing' : 'sparing'} the command`, async (t: TestContext) => {
    const { root, acquire, keepalive, waitForRevision, reacquire, claim } = lane(t);
    const receipt = acquire('30');
    const pidFile = join(root, 'child.pid');
    const running = keepalive(['--claim-proof', JSON.stringify(receipt), '--ttl', '30', ...(kill ? ['--kill-on-loss'] : []), '--',
      'node', '-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 120000)`]);
    await waitForRevision(2);
    for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt++) await delay(100);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    const second = reacquire(receipt, '30');
    assert.equal(second.generation, receipt.generation + 1);
    const finished = await running;
    assert.equal(finished.status, 5);
    assert.equal(finished.error?.code, 'claim_lost');
    assert.equal(claim().lease.generation, second.generation);
    assert.equal(claim().lease.revision, second.revision);
    await delay(500);
    assert.equal(alive(pid), !kill);
    if (!kill) process.kill(pid, 'SIGKILL');
  });

  test('stops with exit 0 when the claim is released', async (t: TestContext) => {
    const { acquire, keepalive, waitForRevision, release, claim } = lane(t);
    const receipt = acquire('30');
    const running = keepalive(['--claim-proof', JSON.stringify(receipt), '--ttl', '30', '--', ...sleeper(60)]);
    await waitForRevision(2);
    release(receipt);
    const finished = await running;
    assert.deepEqual(finished, { status: 0, error: undefined });
    assert.equal(claim().state, 'released');
  });

  test('reports claim_lost at once for a proof from an older generation', async (t: TestContext) => {
    const { acquire, keepalive, reacquire, claim } = lane(t);
    const first = acquire('30');
    const second = reacquire(first, '30');
    const finished = await keepalive(['--claim-proof', JSON.stringify(first), '--ttl', '30', '--', ...sleeper(60)]);
    assert.equal(finished.status, 5);
    assert.equal(finished.error?.code, 'claim_lost');
    assert.equal(claim().lease.revision, second.revision);
  });

  test('ends in --pid mode when the watched process exits', async (t: TestContext) => {
    const { acquire, keepalive, claim } = lane(t);
    const receipt = acquire('30');
    const watched = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)']);
    const finished = await keepalive(['--claim-proof', JSON.stringify(receipt), '--ttl', '30', '--pid', String(watched.pid)]);
    assert.deepEqual(finished, { status: 0, error: undefined });
    assert.equal(claim().lease.revision, 2);
  });

  test('refuses an issue labeled main-lock without renewing', async (t: TestContext) => {
    const { acquire, keepalive, claim } = lane(t, ['main-lock']);
    const receipt = acquire('120');
    const finished = await keepalive(['--claim-proof', JSON.stringify(receipt), '--', ...sleeper(30)]);
    assert.equal(finished.status, 4);
    assert.equal(finished.error?.code, 'main_lock_refused');
    assert.equal(claim().lease.revision, 1);
  });

  test('enforces --max-duration by ceasing to renew', async (t: TestContext) => {
    const { root, acquire, keepalive, claim } = lane(t);
    const receipt = acquire('30');
    const pidFile = join(root, 'child.pid');
    const finished = await keepalive(['--claim-proof', JSON.stringify(receipt), '--ttl', '30', '--max-duration', '3', '--',
      'node', '-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 120000)`]);
    assert.equal(finished.status, 6);
    assert.equal(finished.error?.code, 'keepalive_max_duration');
    assert.equal(claim().lease.revision, 2);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.equal(alive(pid), true);
    process.kill(pid, 'SIGKILL');
  });

  test('rejects an out-of-range duration and an ambiguous target before touching the store', async (t: TestContext) => {
    const { acquire, keepalive, claim } = lane(t);
    const proof = JSON.stringify(acquire('30'));
    const cases: string[][] = [
      ['--max-duration', String(maximumMaxDurationSeconds + 1), '--', 'true'],
      ['--max-duration', '0', '--', 'true'],
      ['--max-duration', 'abc', '--', 'true'],
      [],
      ['--pid', String(process.pid), '--', 'true'],
      ['--pid', String(process.pid), '--kill-on-loss'],
    ];
    for (const rest of cases) {
      const finished = await keepalive(['--claim-proof', proof, ...rest]);
      assert.equal(finished.status, 2, rest.join(' '));
      assert.equal(finished.error?.code, 'invalid_input');
    }
    assert.equal(claim().lease.revision, 1);
  });
});

test('the default duration is two hours and the maximum is eight', () => {
  assert.equal(defaultMaxDurationSeconds, 7200);
  assert.equal(maximumMaxDurationSeconds, 28800);
});

test('renewal is due a third of the TTL before the deadline and a slow call shortens the wait', () => {
  assert.equal(renewalDelayMs({ observedAt: 1000, expiresAt: 1030, ttl: 30, elapsedMs: 0 }), 20000);
  assert.equal(renewalDelayMs({ observedAt: 1000, expiresAt: 1030, ttl: 30, elapsedMs: 4000 }), 16000);
  assert.equal(renewalDelayMs({ observedAt: 1000, expiresAt: 1030, ttl: 30, elapsedMs: 25000 }), 0);
  assert.equal(renewalDelayMs({ observedAt: 1000, expiresAt: 1031, ttl: 31, elapsedMs: 0 }), 20000);
  assert.equal(renewalDelayMs({ observedAt: 1000, expiresAt: 1005, ttl: 30, elapsedMs: 0 }), 0);
});
