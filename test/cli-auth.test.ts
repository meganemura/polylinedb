// Verifies auth grammar, JSON output, and real OAuth wiring without live credentials or HTTPS traffic.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { childStarted, runChild } from './fixtures/child-run.ts';

const executable = new URL('../src/cli.ts', import.meta.url).pathname;
const preload = new URL('./fixtures/cli-auth-preload.ts', import.meta.url).pathname;
async function fixture(context: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pd-cli-auth-')));
  const cwd = join(root, 'work');
  mkdirSync(cwd);
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    POLYLINEDB_CONNECTION: undefined, POLYLINEDB_DATA_DIR: undefined, POLYLINEDB_ACTOR: undefined,
    PD_AUTH_FIXTURE_STATE: join(root, 'synthetic-credential'), PD_AUTH_FIXTURE_MODE: 'normal', PD_OAUTH_LISTENER_CODE: '' };
  const run = async (args: string[], status = 0, mode = 'normal', listenerCode?: string) => {
    const result = await runChild(`pd ${args.join(' ')}`, process.execPath, ['--import', childStarted, '--import', preload, executable, ...args], {
      cwd, env: { ...env, PD_AUTH_FIXTURE_MODE: mode, PD_OAUTH_LISTENER_CODE: listenerCode ?? '' },
    });
    assert.equal(result.status, status, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.stdout.includes('synthetic-access-token'), false);
    assert.equal(result.stderr.includes('synthetic-private-token'), false);
    return result;
  };
  await run(['connection', 'add', 'cloud', '--url', 'https://issues.example.invalid']);
  return { root, cwd, env, run };
}

test('auth grammar and local selection reject before credential access or state creation', async context => {
  const { root, run } = await fixture(context);
  for (const args of [['auth'], ['auth', 'unknown'], ['auth', 'status', 'extra'], ['auth', 'login', '--actor', 'local:spoof'],
    ['auth', 'status', '--prefix', 'pd'], ['auth', 'logout', '--data-dir', root], ['auth', 'status', '--tool', 'tool']]) {
    const result = await run(['--connection', 'cloud', ...args], 2, 'unexpected');
    assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr).error.code, 'invalid_input');
  }
  for (const action of ['login', 'status', 'logout']) {
    const result = await run(['auth', action], 2, 'unexpected');
    assert.equal(JSON.parse(result.stderr).error.message, 'Authentication requires a cloud connection');
  }
  assert.equal(existsSync(join(root, 'config', 'polylinedb', 'auth')), false);
  assert.equal(existsSync(join(root, 'data')), false);
});

test('auth status and logout emit local JSON without live OS commands or local databases', async context => {
  const { root, run } = await fixture(context);
  const status = await run(['auth', 'status', '--connection', 'cloud']);
  assert.equal(status.stderr, '');
  assert.deepEqual(JSON.parse(status.stdout), { resource: 'https://issues.example.invalid', issuer: null,
    state: 'logged_out', expiresAt: null, needsRefresh: false, refreshAvailable: false });
  const logout = await run(['--connection', 'cloud', 'auth', 'logout']);
  assert.equal(logout.stderr, '');
  assert.deepEqual(JSON.parse(logout.stdout), { resource: 'https://issues.example.invalid', local: 'deleted', revocation: 'not_needed' });
  assert.equal(existsSync(join(root, 'data')), false);
});

test('auth login sends the authorization URL to stderr and returns grant status on stdout', async context => {
  const { root, run } = await fixture(context);
  const result = await run(['auth', 'login', '--connection', 'cloud']);
  const authorization = new URL(result.stderr.trim());
  assert.equal(authorization.origin, 'https://auth.example.invalid');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const status = JSON.parse(result.stdout);
  assert.equal(status.state, 'stored');
  assert.equal(status.resource, 'https://issues.example.invalid');
  assert.equal(status.refreshAvailable, true);
  assert.equal((await run(['auth', 'status', '--connection', 'cloud'])).stderr, '');
  assert.equal(existsSync(join(root, 'data')), false);
});

test('auth backend errors stay safe and never expose child diagnostics', async context => {
  const { run } = await fixture(context);
  for (const mode of ['denied', 'unexpected']) {
    const result = await run(['auth', 'status', '--connection', 'cloud'], 1, mode);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), { error: { code: 'auth_store_unavailable',
      message: 'The OS credential store is unavailable or did not complete the operation.' } });
  }
});

test('auth state write denial reports safe guidance without its path', async context => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    context.skip('This permission fixture requires a non-root Unix process.');
    return;
  }
  const { root, run } = await fixture(context);
  const stateDirectory = join(root, 'config', 'polylinedb', 'auth');
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  chmodSync(stateDirectory, 0o500);
  try {
    const result = await run(['auth', 'status', '--connection', 'cloud'], 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), { error: { code: 'auth_state_access_denied',
      message: 'Authentication state is not writable. Allow access to the authentication state directory and retry.' } });
    assert.equal(result.stderr.includes(root), false);
    assert.equal(existsSync(join(root, 'synthetic-credential')), false);
  } finally {
    chmodSync(stateDirectory, 0o700);
  }
});

test('repository-selected cloud auth ignores the retained local actor', async context => {
  const { cwd, env, run } = await fixture(context);
  execFileSync('git', ['init', '--quiet', cwd], { env });
  await run(['init', '--connection', 'cloud', '--tool', 'tool', '--project', 'demo']);
  assert.equal(JSON.parse((await run(['auth', 'status'])).stdout).state, 'logged_out');
});

test('auth listener errors distinguish busy ports, denied access, and other failures', async context => {
  const { run } = await fixture(context);
  for (const [code, message] of [
    ['EADDRINUSE', 'The registered callback port is unavailable. Close the process using it and retry.'],
    ['EPERM', 'The current environment does not permit the loopback callback.'],
    ['EACCES', 'The current environment does not permit the loopback callback.'],
    ['EIO', 'The callback listener could not start.'],
  ]) {
    const result = await run(['auth', 'login', '--connection', 'cloud'], 1, 'normal', code);
    assert.deepEqual(JSON.parse(result.stderr), { error: { code: 'auth_callback_unavailable', message } });
  }
});
