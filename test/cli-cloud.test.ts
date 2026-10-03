// Exercises source and installed cloud CLIs against synthetic OAuth and real domain storage.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const executable = process.env.PD_CLI_EXECUTABLE ?? new URL('../src/cli.ts', import.meta.url).pathname;
const preload = new URL('./fixtures/cli-auth-preload.ts', import.meta.url).pathname;
function fixture(context: test.TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pd-cli-cloud-')));
  const cwd = join(root, 'work');
  mkdirSync(cwd);
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const credential = join(root, 'synthetic-credential');
  const session = { version: 1, resource: 'https://issues.example.invalid',
    metadata: { issuer: 'https://auth.example.invalid', authorization: 'https://auth.example.invalid/authorize',
      token: 'https://auth.example.invalid/token', registration: 'https://auth.example.invalid/register', revocation: null },
    registration: { clientId: 'synthetic-public-client', redirectUri: 'http://127.0.0.1:12345/callback/0123456789abcdef0123456789abcdef' },
    grant: { accessToken: 'synthetic-access-token', refreshToken: 'synthetic-refresh-token', expiresAt: Date.now() + 3600000, scope: '' } };
  writeFileSync(credential, 'pd-oauth-v1:' + Buffer.from(JSON.stringify(session)).toString('base64'), { mode: 0o600 });
  const log = join(root, 'requests.jsonl');
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'local-data'),
    POLYLINEDB_CONNECTION: undefined, POLYLINEDB_DATA_DIR: undefined, POLYLINEDB_ACTOR: 'local:dormant',
    PD_AUTH_FIXTURE_STATE: credential, PD_AUTH_FIXTURE_MODE: 'normal', PD_CLOUD_FIXTURE_STORE: join(root, 'remote-domain-store'),
    PD_CLOUD_FIXTURE_LOG: log, PD_CLOUD_FIXTURE_MODE: 'normal' };
  const run = (args: string[], options: { status?: number; mode?: string; auth?: string; input?: string } = {}) => {
    const result = spawnSync(process.execPath, ['--import', preload, executable, ...args], { cwd,
      env: { ...env, PD_AUTH_FIXTURE_MODE: options.auth ?? 'normal', PD_CLOUD_FIXTURE_MODE: options.mode ?? 'normal' },
      encoding: 'utf8', input: options.input, timeout: 10000 });
    assert.equal(result.status, options.status ?? 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.status === 0 ? result.stderr : result.stdout, '');
    assert.equal(result.stderr.includes('synthetic-private-token'), false);
    assert.equal(result.stdout.includes('synthetic-access-token'), false);
    return JSON.parse(result.status === 0 ? result.stdout : result.stderr);
  };
  run(['connection', 'add', 'cloud', '--url', 'https://issues.example.invalid']);
  execFileSync('git', ['init', '--quiet', cwd], { env });
  run(['init', '--connection', 'cloud', '--tool', 'cli-test', '--project', 'sample', '--prefix', 'sm']);
  const requests = (): { op: string; request_id?: string }[] => existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { root, run, requests };
}

test('cloud CLI executes all nine operations with defaults, actor ownership, body input, and field conflicts', context => {
  const { root, run, requests } = fixture(context);
  assert.deepEqual(run(['actor']), { actor: 'oauth:synthetic-owner' });
  const created = run(['create', '--body-file', '-'], { input: 'Original issue' }).issue;
  assert.equal(created.id, 'sm-1');
  assert.equal(created.tool, 'cli-test');
  assert.equal(created.project, 'sample');
  assert.equal(created.created_by, 'oauth:synthetic-owner');
  assert.equal(run(['show', '1']).issue.body, 'Original issue');
  assert.deepEqual(run(['list', '--project', 'sample']).issues.map((row: { id: string }) => row.id), ['sm-1']);
  assert.equal(run(['comment', '1', '--body', 'Searchable comment']).comment.created_by, 'oauth:synthetic-owner');
  assert.deepEqual(run(['search', 'Searchable']).issues.map((row: { id: string }) => row.id), ['sm-1']);
  assert.equal(run(['update', '1', '--body', 'Edited issue', '--expect', 'body=1']).issue.versions.body, 2);
  const conflict = run(['update', '1', '--body', 'Stale edit', '--expect', 'body=1'], { status: 4 });
  assert.equal(conflict.error.code, 'conflict');
  assert.deepEqual(conflict.error.details.fields, [{ field: 'body', expected: 1, actual: 2, current: 'Edited issue' }]);
  assert.equal(run(['close', '1', '--expected', '1']).issue.status, 'closed');
  assert.equal(run(['reopen', '1', '--expected', '2']).issue.status, 'open');
  assert.equal(run(['show', '1']).issue.body, 'Edited issue');
  assert.deepEqual([...new Set(requests().map(request => request.op))].sort(),
    ['actor', 'close', 'comment', 'create', 'list', 'reopen', 'search', 'show', 'update']);
  assert.equal(existsSync(join(root, 'local-data')), false);
});

test('cloud context and snapshots reject before authentication, networking, or file access', context => {
  const { root, run, requests } = fixture(context);
  const report = run(['context'], { auth: 'unexpected' });
  assert.equal(report.mode, 'cloud');
  assert.equal(report.actor_source, 'authenticated');
  for (const args of [['import', '--file', join(root, 'missing.json')], ['export', '--file', join(root, 'export.json')]]) {
    assert.equal(run(args, { status: 2, auth: 'unexpected' }).error.code, 'cloud_snapshot_not_supported');
  }
  assert.equal(run(['actor', '--actor', 'local:spoof'], { status: 2, auth: 'unexpected' }).error.code, 'invalid_input');
  assert.equal(run(['update', '1', '--body', 'Missing expectation'], { status: 2, auth: 'unexpected' }).error.code, 'invalid_input');
  assert.deepEqual(requests(), []);
  assert.equal(existsSync(join(root, 'config', 'polylinedb', 'auth')), false);
  assert.equal(existsSync(join(root, 'export.json')), false);
  assert.equal(existsSync(join(root, 'local-data')), false);
});

test('cloud 401, 403, and communication failures make exactly one operation request', context => {
  const { root, run, requests } = fixture(context);
  for (const [mode, code] of [['401', 'auth_required'], ['403', 'denied'], ['network', 'cloud_unavailable']]) {
    for (const args of [['list'], ['create', '--body', 'Failed create'], ['comment', '1', '--body', 'Failed comment'],
      ['update', '1', '--body', 'Failed update', '--expect', 'body=1']]) {
      const before = requests().length;
      const failure = run(args, { mode, status: 1 });
      assert.equal(failure.error.code, code);
      assert.equal(requests().length, before + 1);
      if (mode === 'network' && args[0] === 'create') assert.equal(failure.error.details.request_id, requests()[before].request_id);
    }
  }
  assert.equal(existsSync(join(root, 'local-data')), false);
});

test('an ambiguous create preserves its request ID, makes one attempt, and explicit replay returns the created issue', context => {
  const { run, requests } = fixture(context);
  const failure = run(['create', '--body', 'Ambiguous creation'], { mode: 'ambiguous', status: 1 });
  assert.equal(failure.error.code, 'cloud_unavailable');
  const requestId = failure.error.details.request_id;
  assert.match(requestId, /^[a-f0-9-]{36}$/);
  assert.equal(requests().length, 1);
  assert.equal(requests()[0].request_id, requestId);
  const replayed = run(['create', '--body', 'Ambiguous creation', '--request-id', requestId]).issue;
  assert.equal(replayed.id, 'sm-1');
  assert.deepEqual(run(['list']).issues.map((row: { id: string }) => row.id), ['sm-1']);
  assert.equal(requests()[1].request_id, requestId);
});
