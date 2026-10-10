// Keep credentials, callback listeners, and HTTPS responses synthetic in CLI test subprocesses.
import childProcess from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import http from 'node:http';
import type { RequestListener, ServerOptions } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { traceCredentialChild } from './credential-trace.ts';
import { initializeStore, openStore } from "../../src/local-store/index.ts";
import { executeOperation, parseOperation } from "../../src/records/index.ts"; import { PolylinedbError } from "../../src/records/errors.ts";

const spawn = childProcess.spawn;
const credentialStore = new URL('./credential-store.sh', import.meta.url).pathname;
Object.defineProperty(childProcess, 'spawn', { value: (executable: string, args: string[], options: SpawnOptions) => {
  if (executable !== '/usr/bin/security' && executable !== '/usr/bin/secret-tool') return spawn(executable, args, options);
  const mode = process.env.PD_AUTH_FIXTURE_MODE;
  if (mode === 'unexpected') throw new Error('synthetic-private-token');
  if (mode !== 'stdin-closed-early') return traceCredentialChild(spawn, '/bin/sh', [credentialStore, '', ...args], options, args);
  // A loaded host can deschedule the runner between spawn and its first stdin write while the child runs to exit.
  const closed = `${process.env.PD_AUTH_FIXTURE_STATE}.stdin-closed-${randomUUID()}`;
  const child = traceCredentialChild(spawn, '/bin/sh', [credentialStore, closed, ...args], options, args);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 10_000;
  while (!existsSync(closed) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 5);
  return child;
} });
const listenerCode = process.env.PD_OAUTH_LISTENER_CODE;
if (listenerCode) {
  const nativeCreateServer = http.createServer;
  Object.defineProperty(http, 'createServer', { value: (options: ServerOptions, listener: RequestListener) => {
    const server = nativeCreateServer(options, listener);
    Object.defineProperty(server, 'listen', { value: () => {
      process.nextTick(() => server.emit('error', Object.assign(new Error('synthetic-private-token'), { code: listenerCode })));
      return server;
    } });
    return server;
  } });
}
// `state:CODE` fails creation of the authentication state directory; `lock:CODE` fails creation of the lock inside it.
const [mkdirTarget, mkdirCode] = (process.env.PD_AUTH_MKDIR_FAILURE ?? '').split(':');
if (mkdirCode) {
  const nativeMkdir = fsPromises.mkdir;
  Object.defineProperty(fsPromises, 'mkdir', { value: (path: string, options?: Parameters<typeof nativeMkdir>[1]) => {
    const target = path.endsWith('.lock') ? 'lock' : path.endsWith('/polylinedb/auth') ? 'state' : undefined;
    if (target !== mkdirTarget) return nativeMkdir(path, options);
    return Promise.reject(Object.assign(new Error(`synthetic-private-token ${path}`), { code: mkdirCode, syscall: 'mkdir', path }));
  } });
}
syncBuiltinESMExports();

function futureFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(futureFields);
  if (typeof value !== 'object' || value === null) return value;
  return { ...Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, futureFields(entry)])), future_field: { nested: ['synthetic-future'] }, labels_json: '["synthetic-future"]' };
}
const networkFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith('http://127.0.0.1:')) return networkFetch(input, init);
  if (url === 'https://issues.example.invalid/v1/operations') {
    const operation = parseOperation(JSON.parse(String(init?.body)));
    const log = process.env.PD_CLOUD_FIXTURE_LOG;
    const directory = process.env.PD_CLOUD_FIXTURE_STORE;
    if (!log || !directory) throw new Error('Synthetic cloud fixture is not configured');
    appendFileSync(log, JSON.stringify(operation) + '\n');
    if (new Headers(init?.headers).get('authorization') !== 'Bearer synthetic-access-token') return new Response(null, { status: 401 });
    const mode = process.env.PD_CLOUD_FIXTURE_MODE;
    if (mode === '401' || mode === '403') return new Response(null, { status: Number(mode) });
    if (mode === 'network') throw new Error('synthetic-private-token');
    const accessErrorPrefix = mode?.startsWith('jwks-unavailable') ? 'jwks-unavailable'
      : mode?.startsWith('access-configuration') ? 'access-configuration' : undefined;
    if (accessErrorPrefix) {
      const variant = mode?.slice(accessErrorPrefix.length).replace(/^-/, '') ?? '';
      const error: Record<string, unknown> = { code: accessErrorPrefix === 'jwks-unavailable' ? 'jwks_unavailable' : 'invalid_access_configuration', message: 'synthetic-private-token' };
      const body: Record<string, unknown> = { error };
      let status = 503;
      if (variant === 'wrong-code') error.code = 'unexpected_error';
      if (variant === 'extra-error-field') error.details = { diagnostic: 'synthetic-private-token' };
      if (variant === 'extra-envelope-field') body.request_id = 'synthetic-private-token';
      if (variant === 'wrong-status-409') status = 409;
      if (variant === 'wrong-status-502') status = 502;
      if (variant === 'long-message') error.message = 'x'.repeat(4097);
      if (variant === 'non-string-message') error.message = 42;
      return Response.json(body, { status });
    }
    // Workers released before search matches answer the opt-in with this envelope and no details.
    if (mode === 'search-without-matches' && operation.op === 'search' && operation.with_matches) {
      return Response.json({ error: { code: 'invalid_input', message: 'Unexpected field: with_matches' } }, { status: 400 });
    }
    initializeStore({ directory });
    const store = openStore({ directory });
    try {
      const result = await executeOperation(store.db, operation, 'oauth:synthetic-owner');
      if (mode === 'ambiguous') throw new Error('synthetic-private-token');
      if (mode === 'show-without-claim' && 'claim' in result && 'comments' in result) { const { claim: _, ...older } = result; return Response.json(older); }
      if (mode === 'future-fields') return Response.json({ ...futureFields(result) as object, ...(operation.op === 'claim_acquire' ? { open_blockers: [] } : {}) });
      return Response.json(result);
    } catch (error) {
      if (error instanceof PolylinedbError) {
        const body = { error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } };
        return Response.json(mode === 'future-fields' ? futureFields(body) : body, { status: error.status });
      }
      throw error;
    } finally { store.close(); }
  }
  if (url === 'https://issues.example.invalid/.well-known/oauth-protected-resource') return Response.json({
    resource: 'https://issues.example.invalid', authorization_servers: ['https://auth.example.invalid'],
  });
  if (url === 'https://auth.example.invalid/.well-known/oauth-authorization-server') return Response.json({
    issuer: 'https://auth.example.invalid', authorization_endpoint: 'https://auth.example.invalid/authorize',
    token_endpoint: 'https://auth.example.invalid/token', registration_endpoint: 'https://auth.example.invalid/register',
    response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
  });
  if (url === 'https://auth.example.invalid/register') {
    const registration = JSON.parse(String(init?.body));
    return Response.json({ client_id: 'synthetic-public-client', redirect_uris: registration.redirect_uris,
      token_endpoint_auth_method: 'none' });
  }
  if (url === 'https://auth.example.invalid/token') return Response.json({ access_token: 'synthetic-access-token',
    refresh_token: 'synthetic-refresh-token', token_type: 'Bearer', expires_in: 3600 });
  throw new Error('synthetic-private-token');
};
const stderrWrite = process.stderr.write.bind(process.stderr);
Object.defineProperty(process.stderr, 'write', { value: (chunk: string | Uint8Array) => {
  const content = String(chunk);
  if (content.startsWith('https://auth.example.invalid/authorize?')) {
    const authorization = new URL(content.trim());
    const callback = new URL(authorization.searchParams.get('redirect_uri') ?? '');
    callback.searchParams.set('state', authorization.searchParams.get('state') ?? '');
    callback.searchParams.set('code', 'synthetic-code');
    void networkFetch(callback).catch(() => {});
  }
  return stderrWrite(chunk);
} });
