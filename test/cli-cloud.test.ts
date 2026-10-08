// Exercises source and installed cloud CLIs against synthetic OAuth and real domain storage.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { childStarted, runChild } from './fixtures/child-run.ts';

const executable = process.env.PD_CLI_EXECUTABLE ?? new URL('../src/cli.ts', import.meta.url).pathname;
const preload = new URL('./fixtures/cli-auth-preload.ts', import.meta.url).pathname;
async function fixture(context: test.TestContext) {
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
  const trace = join(root, 'credential-outcomes.jsonl');
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'local-data'),
    POLYLINEDB_CONNECTION: undefined, POLYLINEDB_DATA_DIR: undefined, POLYLINEDB_ACTOR: 'local:dormant', POLYLINEDB_SESSION_ID: undefined,
    PD_AUTH_FIXTURE_STATE: credential, PD_AUTH_FIXTURE_MODE: 'normal', PD_AUTH_FIXTURE_TRACE: trace,
    PD_CLOUD_FIXTURE_STORE: join(root, 'remote-domain-store'),
    PD_CLOUD_FIXTURE_LOG: log, PD_CLOUD_FIXTURE_MODE: 'normal' };
  const traceTail = () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').slice(-3).join('\n') : '';
  const run = async (args: string[], options: { status?: number; mode?: string; auth?: string; input?: string; trace?: string; raw?: boolean } = {}) => {
    const result = await runChild(`pd ${args.join(' ')}`, process.execPath, ['--import', childStarted, '--import', preload, executable, ...args], { cwd,
      env: { ...env, PD_AUTH_FIXTURE_MODE: options.auth ?? 'normal', PD_CLOUD_FIXTURE_MODE: options.mode ?? 'normal',
        PD_AUTH_FIXTURE_TRACE: options.trace ?? trace },
      input: options.input }).catch((error: Error) => { throw new Error(`${error.message}\n${traceTail()}`, { cause: error }); });
    const expected = options.status ?? 0;
    const diagnostic = result.status !== expected ? traceTail() : '';
    assert.equal(result.status, expected, `${result.stderr}\n${result.stdout}\n${diagnostic}`);
    assert.equal(result.status === 0 ? result.stderr : result.stdout, '');
    assert.equal(result.stderr.includes('synthetic-private-token'), false);
    assert.equal(result.stdout.includes('synthetic-access-token'), false);
    return options.raw ? result.stdout : JSON.parse(result.status === 0 ? result.stdout : result.stderr);
  };
  await run(['connection', 'add', 'cloud', '--url', 'https://issues.example.invalid']);
  execFileSync('git', ['init', '--quiet', cwd], { env });
  await run(['init', '--connection', 'cloud', '--tool', 'cli-test', '--project', 'sample', '--prefix', 'sm']);
  const requests = (): { op: string; request_id?: string }[] => existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return { root, run, requests, trace };
}

test('synthetic credential diagnostics capture rejection without exposing child output', async context => {
  const { root, run, trace } = await fixture(context);
  assert.equal((await run(['actor'], { auth: 'denied', status: 1 })).error.code, 'auth_store_unavailable');
  const diagnostics = readFileSync(trace, 'utf8');
  assert.equal(diagnostics.includes('synthetic-private-token'), false);
  assert.equal(diagnostics.includes('synthetic-access-token'), false);
  const outcome = JSON.parse(diagnostics.trim().split('\n').at(-1) ?? '');
  assert.equal(outcome.category, 'read');
  assert.equal(outcome.status, 1);
  assert.equal(outcome.stdout_bytes, 0);
  assert.equal(outcome.stderr_bytes, Buffer.byteLength('synthetic-private-token'));
  await assert.rejects(run(['actor'], { auth: 'denied' }), error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes('synthetic-private-token'), false);
    assert.equal(error.message.includes('"status":1'), true);
    return true;
  });
  assert.deepEqual(await run(['actor'], { trace: root }), { actor: 'oauth:synthetic-owner' });
});

test('a credential read succeeds when the child closes stdin before the CLI reaches it', async context => {
  const { run } = await fixture(context);
  assert.deepEqual(await run(['actor'], { auth: 'stdin-closed-early' }), { actor: 'oauth:synthetic-owner' });
});

test('cloud CLI executes all nine operations with defaults, actor ownership, body input, and field conflicts', async context => {
  const { root, run, requests } = await fixture(context);
  assert.deepEqual(await run(['actor']), { actor: 'oauth:synthetic-owner' });
  const created = (await run(['create', '--body-file', '-'], { input: 'Original issue' })).issue;
  assert.equal(created.id, 'sm-1');
  assert.equal(created.tool, 'cli-test');
  assert.equal(created.project, 'sample');
  assert.equal(created.created_by, 'oauth:synthetic-owner');
  assert.equal((await run(['show', '1'])).issue.body, 'Original issue');
  const missingNumeric = (await run(['show', '48'], { status: 3 })).error;
  assert.deepEqual(missingNumeric, {
    code: 'not_found', message: 'The cloud rejected the operation.',
    details: { id: 'sm-48', prefix: 'sm', prefix_source: 'repository' },
  });
  assert.deepEqual(requests().at(-1), { op: 'show', id: 'sm-48' });
  assert.deepEqual((await run(['show', 'sm-49'], { status: 3 })).error, {
    code: 'not_found', message: 'The cloud rejected the operation.', details: { id: 'sm-49' },
  });
  assert.deepEqual((await run(['--prefix', 'flag', 'show', '50'], { status: 3 })).error, {
    code: 'not_found', message: 'The cloud rejected the operation.',
    details: { id: 'flag-50', prefix: 'flag', prefix_source: 'flag' },
  });
  assert.deepEqual((await run(['list', '--project', 'sample'])).issues.map((row: { id: string }) => row.id), ['sm-1']);
  assert.equal((await run(['comment', '1', '--body', 'Searchable comment'])).comment.created_by, 'oauth:synthetic-owner');
  assert.deepEqual((await run(['search', 'Searchable'])).issues.map((row: { id: string }) => row.id), ['sm-1']);
  assert.equal((await run(['update', '1', '--body', 'Edited issue', '--expect', 'body=1'])).issue.versions.body, 2);
  const conflict = await run(['update', '1', '--body', 'Stale edit', '--expect', 'body=1'], { status: 4 });
  assert.equal(conflict.error.code, 'conflict');
  assert.deepEqual(conflict.error.details.fields, [{ field: 'body', expected: 1, actual: 2, current: 'Edited issue' }]);
  assert.equal((await run(['close', '1', '--expected', '1'])).issue.status, 'closed');
  assert.equal((await run(['reopen', '1', '--expected', '2'])).issue.status, 'open');
  assert.equal((await run(['show', '1'])).issue.body, 'Edited issue');
  assert.deepEqual([...new Set(requests().map(request => request.op))].sort(),
    ['actor', 'close', 'comment', 'create', 'list', 'reopen', 'search', 'show', 'update']);
  assert.equal(existsSync(join(root, 'local-data')), false);
});
test('cloud human issue reads use the formatter and retain pagination and safe body text', async context => {
  const { run, requests } = await fixture(context);
  const body = 'Cloud ESC:\u001b[31m C1:\u0085 DEL:\u007f LS:\u2028 PS:\u2029\n日本語';
  const { issue } = await run(['create', '--body', body]);
  await run(['comment', issue.id, '--body', '確認しました。\n次へ進みます。']);
  const second = (await run(['create', '--body', 'Second cloud issue'])).issue;

  const details = await run(['show', issue.id, '--human'], { raw: true });
  assert.ok(details.startsWith('Issue details\nID sm-1\nStatus open\n'));
  assert.ok(details.includes('Body\n  Cloud ESC:\\u001B[31m C1:\\u0085 DEL:\\u007F LS:\\u2028 PS:\\u2029\n  日本語\nComments (1)\n'));
  assert.ok(details.includes('    確認しました。\n    次へ進みます。'));
  assert.equal(details.includes('\u001b'), false);

  const firstPage = await run(['list', '--human', '--limit', '1'], { raw: true });
  assert.ok(firstPage.startsWith('Issues\nsm-1  open  P2  task\n'));
  assert.ok(firstPage.endsWith('\n  sm-1\n'));
  const nextPage = await run(['list', '--limit', '1', '--after', 'sm-1', '--human'], { raw: true });
  assert.ok(nextPage.startsWith(`Issues\n${second.id}  open  P2  task\n`));
  assert.ok(nextPage.endsWith('\nEnd of results.\n'));
  const matches = await run(['search', 'Second cloud issue', '--human'], { raw: true });
  assert.ok(matches.startsWith(`Search matches\n${second.id}  open  P2  task\n`));
  assert.deepEqual(requests().map(request => request.op), ['create', 'comment', 'create', 'show', 'list', 'list', 'search']);
});
test('cloud CLI claim flags recover original receipts after every ambiguous mutation', async context => {
  const { root, run, requests } = await fixture(context); await run(['create', '--body', 'Cloud claim']);
  const inspected = (await run(['claim', 'show', '1'])).claim; const session = crypto.randomUUID(); const acquireRequest = crypto.randomUUID();
  const acquisition = ['claim', 'acquire', '1', '--incarnation', inspected.store_incarnation, '--session-id', session, '--request-id', acquireRequest, '--agent-label', 'Codex'];
  const before = requests().length; const lost = await run(acquisition, { mode: 'ambiguous', status: 1 }); assert.equal(lost.error.code, 'cloud_unavailable'); assert.deepEqual(lost.error.details, { request_id: acquireRequest }); assert.equal(requests().length, before + 1);
  const acquired = await run(acquisition); const receipt = acquired.claim_receipt; assert.equal(receipt.actor, 'oauth:synthetic-owner'); assert.equal(receipt.session_id, session);
  const proof = JSON.stringify({ issue_id: receipt.issue_id, incarnation: receipt.incarnation, session_id: receipt.session_id, generation: receipt.generation });
  assert.equal((await run(['close', '1', '--expected', '1'], { status: 4 })).error.code, 'claim_required');
  assert.equal((await run(['close', '1', '--expected', '1', '--claim-proof', proof])).issue.status, 'closed');
  const renewalRequest = crypto.randomUUID(); const renewal = ['claim', 'renew', '--claim-proof', proof, '--expected-revision', '1', '--request-id', renewalRequest];
  assert.deepEqual((await run(renewal, { mode: 'ambiguous', status: 1 })).error.details, { request_id: renewalRequest }); assert.equal((await run(renewal)).claim_receipt.revision, 2);
  const releaseRequest = crypto.randomUUID(); const release = ['claim', 'release', '--claim-proof', proof, '--expected-revision', '2', '--request-id', releaseRequest];
  assert.deepEqual((await run(release, { mode: 'ambiguous', status: 1 })).error.details, { request_id: releaseRequest }); assert.equal((await run(release)).claim_receipt.outcome, 'released');
  assert.deepEqual(await run(acquisition), acquired); assert.equal((await run(['claim', 'list', '--project', 'sample'])).claims[0].state, 'released');
  const after = requests().length;
  assert.equal((await run(['claim', 'renew', '--claim-proof', '{}', '--expected-revision', '1'], { auth: 'unexpected', status: 2 })).error.code, 'invalid_input'); assert.equal(requests().length, after);
  assert.equal(existsSync(join(root, 'local-data')), false);
});

test('cloud context and snapshots reject before authentication, networking, or file access', async context => {
  const { root, run, requests } = await fixture(context);
  assert.equal((await run(['memory', 'context', '--project', 'sample', '--human'], { auth: 'unexpected', status: 2 })).error.code, 'invalid_input');
  const report = await run(['context'], { auth: 'unexpected' });
  assert.equal(report.mode, 'cloud');
  assert.equal(report.actor_source, 'authenticated');
  for (const args of [['import', '--file', join(root, 'missing.json')], ['export', '--file', join(root, 'export.json')]]) {
    assert.equal((await run(args, { status: 2, auth: 'unexpected' })).error.code, 'cloud_snapshot_not_supported');
  }
  assert.equal((await run(['actor', '--actor', 'local:spoof'], { status: 2, auth: 'unexpected' })).error.code, 'invalid_input');
  assert.equal((await run(['update', '1', '--body', 'Missing expectation'], { status: 2, auth: 'unexpected' })).error.code, 'invalid_input');
  assert.deepEqual(requests(), []);
  assert.equal(existsSync(join(root, 'config', 'polylinedb', 'auth')), false);
  assert.equal(existsSync(join(root, 'export.json')), false);
  assert.equal(existsSync(join(root, 'local-data')), false);
});

test('cloud 401, 403, and communication failures make exactly one operation request', async context => {
  const { root, run, requests } = await fixture(context);
  for (const [mode, code] of [['401', 'auth_required'], ['403', 'denied'], ['network', 'cloud_unavailable']]) {
    for (const args of [['list'], ['create', '--body', 'Failed create'], ['comment', '1', '--body', 'Failed comment'],
      ['update', '1', '--body', 'Failed update', '--expect', 'body=1']]) {
      const before = requests().length;
      const failure = await run(args, { mode, status: 1 });
      assert.equal(failure.error.code, code);
      assert.equal(requests().length, before + 1);
      if (mode === 'network' && args[0] === 'create') assert.equal(failure.error.details.request_id, requests()[before].request_id);
    }
  }
  assert.equal(existsSync(join(root, 'local-data')), false);
});

test('an ambiguous create preserves its request ID, makes one attempt, and explicit replay returns the created issue', async context => {
  const { run, requests } = await fixture(context);
  const failure = await run(['create', '--body', 'Ambiguous creation'], { mode: 'ambiguous', status: 1 });
  assert.equal(failure.error.code, 'cloud_unavailable');
  const requestId = failure.error.details.request_id;
  assert.match(requestId, /^[a-f0-9-]{36}$/);
  assert.equal(requests().length, 1);
  assert.equal(requests()[0].request_id, requestId);
  const replayed = (await run(['create', '--body', 'Ambiguous creation', '--request-id', requestId])).issue;
  assert.equal(replayed.id, 'sm-1');
  assert.deepEqual((await run(['list'])).issues.map((row: { id: string }) => row.id), ['sm-1']);
  assert.equal(requests()[1].request_id, requestId);
});

test('cloud CLI reports valid 503 access configuration errors with fixed guidance', async context => {
  const { run, requests } = await fixture(context);
  assert.deepEqual(await run(['actor']), { actor: 'oauth:synthetic-owner' });
  const actorFailure = (await run(['actor'], { mode: 'access-configuration', status: 1 })).error;
  assert.deepEqual(actorFailure, { code: 'invalid_access_configuration', message: 'Cloud Access is misconfigured. Check the Worker Access configuration.' });
  assert.equal(JSON.stringify(actorFailure).includes('synthetic-private-token'), false);
  const createFailure = (await run(['create', '--body', 'Access configuration error'], { mode: 'access-configuration', status: 1 })).error;
  const requestId = requests().at(-1)?.request_id;
  assert.match(requestId ?? '', /^[a-f0-9-]{36}$/);
  assert.deepEqual(createFailure, { code: 'invalid_access_configuration', message: 'Cloud Access is misconfigured. Check the Worker Access configuration.', details: { request_id: requestId } });
  assert.equal(JSON.stringify(createFailure).includes('synthetic-private-token'), false);
});

test('cloud CLI reports unavailable signing keys with fixed guidance and one attempt', async context => {
  const { run, requests } = await fixture(context);
  const actorStart = requests().length;
  const actorFailure = (await run(['actor'], { mode: 'jwks-unavailable', status: 1 })).error;
  assert.deepEqual(actorFailure, { code: 'jwks_unavailable',
    message: 'Cloud signing keys are temporarily unavailable. Retry later with the same request ID when one was returned.' });
  assert.equal(requests().length, actorStart + 1);
  const createStart = requests().length;
  const createFailure = (await run(['create', '--body', 'Unavailable signing keys'], { mode: 'jwks-unavailable', status: 1 })).error;
  const requestId = requests()[createStart].request_id;
  assert.match(requestId ?? '', /^[a-f0-9-]{36}$/);
  assert.deepEqual(createFailure, { code: 'jwks_unavailable',
    message: 'Cloud signing keys are temporarily unavailable. Retry later with the same request ID when one was returned.',
    details: { request_id: requestId } });
  assert.equal(requests().length, createStart + 1);
});

test('cloud CLI rejects malformed JWKS 503 envelopes and unsupported 502 responses', async context => {
  const { run, requests } = await fixture(context);
  for (const mode of ['jwks-unavailable-wrong-code',
    'jwks-unavailable-wrong-status-502', 'jwks-unavailable-long-message', 'jwks-unavailable-non-string-message']) {
    const before = requests().length;
    const result = await run(['actor'], { mode, status: 1 });
    assert.deepEqual(result.error, { code: 'cloud_invalid_response', message: 'The cloud returned an invalid operation response.' }, mode);
    assert.equal(requests().length, before + 1, mode);
    assert.equal(JSON.stringify(result).includes('synthetic-private-token'), false, mode);
  }
});

test('cloud CLI rejects invalid 503 access configuration envelopes and status codes', async context => {
  const { run } = await fixture(context);
  for (const mode of ['access-configuration-wrong-code',
    'access-configuration-wrong-status-409', 'access-configuration-wrong-status-502', 'access-configuration-long-message', 'access-configuration-non-string-message']) {
    const result = await run(['actor'], { mode, status: 1 });
    assert.deepEqual(result.error, { code: 'cloud_invalid_response', message: 'The cloud returned an invalid operation response.' }, mode);
    assert.equal(JSON.stringify(result).includes('synthetic-private-token'), false, mode);
  }
});

test('cloud CLI accepts 503 envelopes with unknown fields and keeps the fixed guidance', async context => {
  const { run } = await fixture(context);
  for (const [prefix, code, message] of [['jwks-unavailable', 'jwks_unavailable', 'Cloud signing keys are temporarily unavailable. Retry later with the same request ID when one was returned.'],
    ['access-configuration', 'invalid_access_configuration', 'Cloud Access is misconfigured. Check the Worker Access configuration.']]) {
    for (const variant of ['extra-error-field', 'extra-envelope-field']) {
      const result = await run(['actor'], { mode: `${prefix}-${variant}`, status: 1 });
      assert.deepEqual(result.error, { code, message }, variant);
      assert.equal(JSON.stringify(result).includes('synthetic-private-token'), false, variant);
    }
  }
});

test('cloud CLI reads show and claim acquire from older and newer Worker response shapes', async context => {
  const { run, requests } = await fixture(context);
  const { issue } = await run(['create', '--body', 'Compatible shapes']);
  await run(['comment', issue.id, '--body', 'Noted']);
  const current = await run(['show', issue.id]);
  const timeless = (shown: { claim: { observed_at: number } }) => ({ ...shown, claim: { ...shown.claim, observed_at: 0 } });
  const before = requests().length;
  assert.deepEqual(timeless(await run(['show', issue.id], { mode: 'show-without-claim' })), timeless(current));
  assert.deepEqual(requests().slice(before).map(request => request.op), ['show', 'claim_show']);
  const newer = await run(['show', issue.id], { mode: 'future-fields', raw: true });
  assert.equal(newer.includes('synthetic-future'), false);
  assert.deepEqual(timeless(JSON.parse(newer)), timeless(current));
  assert.deepEqual(requests().slice(before + 2).map(request => request.op), ['show']);
  const claimLine = `Claim never_claimed · store incarnation ${current.claim.store_incarnation}`;
  for (const mode of ['show-without-claim', 'future-fields']) {
    const human = await run(['show', issue.id, '--human'], { mode, raw: true });
    assert.ok(human.split('\n').includes(claimLine), mode);
    assert.equal(human.includes('synthetic-future'), false, mode);
  }
  assert.deepEqual(await run(['show', '48'], { mode: 'future-fields', status: 3 }), await run(['show', '48'], { status: 3 }));
  const acquisition = ['claim', 'acquire', issue.id, '--incarnation', current.claim.store_incarnation, '--session-id', crypto.randomUUID(), '--request-id', crypto.randomUUID()];
  const acquired = await run(acquisition, { mode: 'future-fields', raw: true });
  assert.equal(acquired.includes('synthetic-future'), false);
  assert.deepEqual(JSON.parse(acquired), await run(acquisition));
});

test('cloud CLI searches an older Worker that rejects with_matches through one plain search', async context => {
  const { run, requests } = await fixture(context);
  const { issue } = await run(['create', '--body', 'Older Worker search']);
  const { matches, ...page } = await run(['search', 'Older Worker']);
  assert.equal(matches.length, 1);
  const before = requests().length;
  assert.deepEqual(await run(['search', 'Older Worker'], { mode: 'search-without-matches' }), page);
  assert.deepEqual(requests().slice(before).map(request => [request.op, 'with_matches' in request]), [['search', true], ['search', false]]);
  const human = await run(['search', 'Older Worker', '--human'], { raw: true });
  assert.ok(human.includes(`\n  Matched in body: Older Worker search\n`));
  assert.equal(await run(['search', 'Older Worker', '--human'], { mode: 'search-without-matches', raw: true }),
    human.split('\n').filter((line: string) => !line.startsWith('  Matched in ')).join('\n'));
  assert.ok(human.startsWith(`Search matches\n${issue.id}  open  P2  task\n`));
});
