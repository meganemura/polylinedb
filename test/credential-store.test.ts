/** Checks OS command protocols through private fixtures; tests never open a live credential store. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCredentialStore, runCredentialCommand } from '../src/cloud-client/credential-store.ts';

const key = `oauth-${'a'.repeat(64)}`;
const value = JSON.stringify({ accessToken: 'secret "quote"\n日本語\0', refreshToken: 'refresh' });
const encoded = `pd-oauth-v1:${Buffer.from(value).toString('base64')}`;
type Command = Parameters<typeof runCredentialCommand>[0];
type Result = Awaited<ReturnType<typeof runCredentialCommand>>;
const ok = (stdout = '', stderr = ''): Result => ({ status: 0, stdout, stderr });
const missing: Result = { status: 44, stdout: '', stderr: 'not found' };
function fixture(platform: string, results: Result[]) {
  const calls: Command[] = [];
  const store = createCredentialStore({ platform, runner: async command => {
    calls.push(command);
    const result = results.shift();
    assert.ok(result, 'unexpected command');
    return result;
  } });
  return { store, calls };
}

test('macOS writes one bounded stdin command and confirms its complete UTF-8 value', async () => {
  const { store, calls } = fixture('darwin', [ok('', 'security> '), ok(`${encoded}\n`)]);
  await store.write(key, value);
  assert.deepEqual(calls[0], { executable: '/usr/bin/security', args: ['-i', '-q'], input: `add-generic-password -U -s polylinedb.oauth -a ${key} -w ${encoded}\n` });
  assert.deepEqual(calls[1], { executable: '/usr/bin/security', args: ['find-generic-password', '-s', 'polylinedb.oauth', '-a', key, '-w'] });
  assert.equal(calls[0].args.some(argument => argument.includes('secret')), false);
  assert.equal(calls[0].input?.split('\n').length, 2);
});

test('macOS missing code differs from lock, cancel, process failure and masked write failure', async () => {
  assert.equal(await fixture('darwin', [missing]).store.read(key), null);
  for (const status of [1, 36, 51, 128, null]) {
    await assert.rejects(fixture('darwin', [{ status, stdout: 'private token', stderr: 'private token' }]).store.read(key), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes('private token'), false);
      return true;
    });
  }
  await assert.rejects(fixture('darwin', [ok('', 'command failed'), missing]).store.write(key, value));
  await assert.rejects(fixture('darwin', [ok(), ok('pd-oauth-v1:b2xk\n')]).store.write(key, value));
});

test('macOS deletion requires missing readback and accepts already missing', async () => {
  await fixture('darwin', [ok(), missing]).store.delete(key);
  await fixture('darwin', [missing, missing]).store.delete(key);
  await assert.rejects(fixture('darwin', [ok(), ok(`${encoded}\n`)]).store.delete(key));
  const failed = fixture('darwin', [{ status: 1, stdout: '', stderr: '' }]);
  await assert.rejects(failed.store.delete(key));
  assert.equal(failed.calls.length, 1);
});

test('Linux uses stdin, preserves raw output, and verifies writes', async () => {
  const { store, calls } = fixture('linux', [ok(), ok(encoded)]);
  await store.write(key, value);
  assert.deepEqual(calls[0], { executable: '/usr/bin/secret-tool', args: ['store', '--label', 'polylinedb', 'service', 'polylinedb.oauth', 'account', key], input: encoded });
  assert.deepEqual(calls[1].args, ['lookup', 'service', 'polylinedb.oauth', 'account', key]);
  await assert.rejects(fixture('linux', [ok(), ok('pd-oauth-v1:b2xk')]).store.write(key, value));
});

test('Linux proves absence through search and treats locked or cancelled lookup as unavailable', async () => {
  const lookupMissing: Result = { status: 1, stdout: '', stderr: '' };
  const absent = fixture('linux', [lookupMissing, ok()]);
  assert.equal(await absent.store.read(key), null);
  assert.deepEqual(absent.calls[1].args, ['search', '--all', 'service', 'polylinedb.oauth', 'account', key]);
  for (const search of [ok('[item]\n'), ok('', 'locked'), { status: 1, stdout: '', stderr: '' }]) {
    await assert.rejects(fixture('linux', [lookupMissing, search]).store.read(key));
  }
  for (const failure of [{ status: 1, stdout: '', stderr: 'cancelled' }, { status: 2, stdout: '', stderr: '' }, { status: null, stdout: '', stderr: '' }]) {
    const { store, calls } = fixture('linux', [failure]);
    await assert.rejects(store.read(key));
    assert.equal(calls.length, 1);
  }
});

test('Linux clear cannot report deletion while a credential is present or inaccessible', async () => {
  const notFound: Result = { status: 1, stdout: '', stderr: '' };
  await fixture('linux', [ok(), notFound, ok()]).store.delete(key);
  await fixture('linux', [notFound, notFound, ok()]).store.delete(key);
  await assert.rejects(fixture('linux', [ok(), ok(encoded)]).store.delete(key));
  await assert.rejects(fixture('linux', [ok(), notFound, ok('[locked item]')]).store.delete(key));
  await assert.rejects(fixture('linux', [{ status: 1, stdout: '', stderr: 'cancelled' }]).store.delete(key));
});

test('invalid keys, UTF-8 strings, unsupported platforms and oversized values fail before spawning', async () => {
  for (const platform of ['darwin', 'linux']) {
    const { store, calls } = fixture(platform, []);
    await assert.rejects(store.write(key, 'x'.repeat(8192)));
    await assert.rejects(store.write(key, '\ud800'));
    await assert.rejects(store.write(`${key}\ncommand`, value));
    await assert.rejects(store.read('invalid'));
    await assert.rejects(store.delete('invalid'));
    assert.equal(calls.length, 0);
  }
  const unsupported = fixture('win32', []);
  await assert.rejects(unsupported.store.read(key));
  assert.equal(unsupported.calls.length, 0);
});

test('decoding rejects foreign formats, noncanonical base64 and invalid UTF-8', async () => {
  for (const text of ['plaintext', 'pd-oauth-v1:@@', 'pd-oauth-v1:YQ', 'pd-oauth-v1:YR==', 'pd-oauth-v1:/w==', `${encoded}\n\n`]) {
    await assert.rejects(fixture('darwin', [ok(text)]).store.read(key));
  }
});

test('UTF-8 decoding preserves a leading BOM and size limits apply to encoded bytes', async () => {
  const bom = '\ufeff{"token":"x"}';
  assert.equal(await fixture('linux', [ok(`pd-oauth-v1:${Buffer.from(bom).toString('base64')}`)]).store.read(key), bom);
  for (const platform of ['darwin', 'linux']) {
    const overhead = platform === 'darwin' ? Buffer.byteLength(`add-generic-password -U -s polylinedb.oauth -a ${key} -w pd-oauth-v1:\n`) : Buffer.byteLength('pd-oauth-v1:');
    const limit = platform === 'darwin' ? 4095 : 8191;
    const largest = Math.floor((limit - overhead) / 4) * 3;
    const text = 'x'.repeat(largest);
    const secret = `pd-oauth-v1:${Buffer.from(text).toString('base64')}`;
    const { store, calls } = fixture(platform, [ok(), ok(platform === 'darwin' ? `${secret}\n` : secret)]);
    await store.write(key, text);
    assert.ok(Buffer.byteLength(calls[0].input ?? '') <= limit);
    const refused = fixture(platform, []);
    await assert.rejects(refused.store.write(key, `${text}x`));
    assert.equal(refused.calls.length, 0);
  }
});

const executable = process.execPath;
const path = fileURLToPath(new URL('./fixtures/credential-command.ts', import.meta.url));
test('real child receives secrets only through a non-TTY stdin pipe', async () => {
  const result = await runCredentialCommand({ executable, args: [path, 'echo'], input: value });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { args: ['echo'], stdin: value, tty: false, environment: null });
});

test('real child without input reads an empty non-TTY stdin', async () => {
  const result = await runCredentialCommand({ executable, args: [path, 'echo'] });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { args: ['echo'], stdin: '', tty: false, environment: null });
});

test('real child that exits without reading its input fails the command', async () => {
  const input = 'x'.repeat(4 * 1024 * 1024);
  await assert.rejects(runCredentialCommand({ executable, args: [path, 'unread-input'], input }), /OS credential store/);
});

test('real child timeouts, output overflow, invalid bytes and missing executable produce sanitized errors', async () => {
  for (const mode of ['hang', 'overflow', 'invalid-utf8']) {
    await assert.rejects(runCredentialCommand({ executable, args: [path, mode] }, { timeoutMs: mode === 'hang' ? 150 : 2000, outputBytes: 65536 }), /OS credential store/);
  }
  await assert.rejects(runCredentialCommand({ executable: '/nonexistent/credential-tool', args: [] }), /OS credential store/);
});
