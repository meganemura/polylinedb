/** Owns public-client OAuth discovery, loopback authorization, and secure grant replacement. No browser automation or local database access. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { credentialTransaction, OAuthError } from './credential-session.ts';
import type { CredentialStore } from './credential-session.ts';
export { OAuthError } from './credential-session.ts';
export type { CredentialStore } from './credential-session.ts';

type Metadata = { issuer: string; authorization: string; token: string; registration: string; revocation: string | null };
type Registration = { clientId: string; redirectUri: string };
type Grant = { accessToken: string; refreshToken: string | null; expiresAt: number; scope: string };
type Session = { version: 1; resource: string; metadata: Metadata; registration: Registration; grant: Grant | null };
export type AuthStatus = { resource: string; issuer: string | null; state: 'logged_out' | 'reauthorization_required' | 'stored'; expiresAt: number | null; needsRefresh: boolean; refreshAvailable: boolean };
type Options = { origin: string; credentialStore: CredentialStore; stateDirectory: string; fetch?: typeof globalThis.fetch; requestTimeoutMs?: number; loginTimeoutMs?: number; lockTimeoutMs?: number };
const limit = 64 * 1024;
type CallbackPage = { kind: 'received' } | { kind: 'denied' } | { kind: 'invalid' };
const callbackStyle = `:root{color-scheme:light dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#26312d;background:#f3f5f2}*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px}main{width:100%;max-width:440px;padding:36px;border:1px solid #dce2dc;border-radius:16px;background:#fff;box-shadow:0 8px 32px #26312d08}.brand{margin:0 0 32px;font-size:14px;font-weight:650;letter-spacing:.02em}.mark{display:grid;place-items:center;width:40px;height:40px;margin-bottom:20px;border:1px solid #cfd9d0;border-radius:50%;color:#4c6654;font-size:22px}h1{margin:0 0 16px;font-size:clamp(24px,5vw,28px);line-height:1.2;letter-spacing:-.025em}p{margin:0;line-height:1.6;font-size:15px;color:#526059}.hint{margin-top:24px;padding-top:20px;border-top:1px solid #e5e9e4;font-size:13px;color:#637168}@media(prefers-color-scheme:dark){:root{color:#edf2ed;background:#171c19}main{background:#202722;border-color:#364139;box-shadow:none}.mark{border-color:#506755;color:#b8d0bb}p{color:#c0ccc2}.hint{border-color:#364139;color:#aab9ad}}@media(max-width:380px){body{padding:16px}main{padding:28px 24px}}`;
const callbackPolicy = `default-src 'none'; style-src 'sha256-${createHash('sha256').update(callbackStyle).digest('base64')}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
function callbackPage(page: CallbackPage): string {
  let title: string, message: string, hint: string;
  switch (page.kind) {
    case 'received':
      title = 'Authorization received'; message = 'Return to your terminal to check the login result.'; hint = 'You can close this page.'; break;
    case 'denied':
      title = 'Authorization was not completed'; message = 'Return to your terminal. Run auth login again when you are ready.'; hint = 'You can close this page.'; break;
    case 'invalid':
      title = 'Invalid authorization callback'; message = 'This request could not complete authorization.'; hint = 'Return to your terminal to check the login result.'; break;
    default: {
      const exhaustive: never = page;
      return exhaustive;
    }
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title} | polylinedb</title><style>${callbackStyle}</style></head><body><main><p class="brand">polylinedb</p><span class="mark" aria-hidden="true">&middot;</span><h1>${title}</h1><p>${message}</p><p class="hint">${hint}</p></main></body></html>`;
}
const fail = (code: string, message: string): never => { throw new OAuthError(code, message); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('auth_response_invalid', 'The authentication response is invalid.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 16384): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\x00-\x20\x7f]/.test(value)) return fail('auth_response_invalid', 'The authentication response contains an invalid value.');
  return value;
}
function https(value: unknown): string {
  const raw = text(value, 4096);
  let url: URL;
  try { url = new URL(raw); } catch { return fail('auth_metadata_invalid', 'The authentication URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return fail('auth_metadata_invalid', 'Authentication requires HTTPS URLs without credentials or fragments.');
  return url.href;
}
function root(value: unknown): string {
  const url = new URL(https(value));
  if (url.pathname !== '/' || url.search) return fail('auth_metadata_invalid', 'The cloud resource must be an HTTPS origin.');
  return url.origin;
}
function includes(value: unknown, expected: string): boolean { return Array.isArray(value) && value.includes(expected); }
function endpoint(value: unknown, issuer: string): string {
  const result = https(value);
  if (new URL(result).origin !== issuer) return fail('auth_metadata_invalid', 'An authentication endpoint does not match its issuer.');
  return result;
}
function cloudflareAccessIssuer(issuer: string): boolean {
  const url = new URL(issuer);
  return url.protocol === 'https:' && !url.port && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(url.hostname);
}
function scope(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 4096 || /[^\x20-\x21\x23-\x5b\x5d-\x7e]/.test(value)) return fail('auth_response_invalid', 'The grant scope is invalid.');
  return value;
}
function redirect(value: unknown): string {
  const url = new URL(text(value, 4096));
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || !/^\/callback\/[a-f0-9]{32}$/.test(url.pathname)) return fail('auth_response_invalid', 'The saved callback address is invalid.');
  return url.href;
}
function parseSession(raw: string, resource: string): Session {
  if (Buffer.byteLength(raw) > limit) return fail('auth_credentials_invalid', 'The saved credentials exceed the supported size.');
  try {
    const saved = object(JSON.parse(raw));
    if (saved.version !== 1 || saved.resource !== resource) return fail('auth_credentials_invalid', 'The saved credentials do not match the cloud resource.');
    const m = object(saved.metadata), r = object(saved.registration);
    const issuer = root(m.issuer);
    const metadata = { issuer, authorization: endpoint(m.authorization, issuer), token: endpoint(m.token, issuer), registration: endpoint(m.registration, issuer), revocation: m.revocation === null ? null : endpoint(m.revocation, issuer) };
    let grant: Grant | null = null;
    if (saved.grant !== null) {
      const g = object(saved.grant);
      if (typeof g.expiresAt !== 'number' || !Number.isSafeInteger(g.expiresAt) || g.expiresAt < 0) return fail('auth_credentials_invalid', 'The saved credential expiry is invalid.');
      grant = { accessToken: text(g.accessToken), refreshToken: g.refreshToken === null ? null : text(g.refreshToken), expiresAt: g.expiresAt, scope: scope(g.scope) };
    }
    return { version: 1, resource, metadata, registration: { clientId: text(r.clientId), redirectUri: redirect(r.redirectUri) }, grant };
  } catch { return fail('auth_credentials_invalid', 'The saved credentials are invalid. Log in again after removing the invalid credential entry.'); }
}

async function loopback(savedRedirect: string | null, state: string, issuer: string, timeoutMs: number) {
  const callbackPath = savedRedirect ? new URL(savedRedirect).pathname : `/callback/${randomBytes(16).toString('hex')}`;
  let accept: (code: string) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const code = new Promise<string>((resolve, rejectPromise) => { accept = resolve; reject = rejectPromise; });
  void code.catch(() => {});
  let settled = false;
  const server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', callbackPolicy);
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const address = server.address();
    if (!request.url?.startsWith('/') || request.url.startsWith('//') || typeof address !== 'object' || !address || request.headers.host !== `127.0.0.1:${address.port}`) {
      response.writeHead(400).end(callbackPage({ kind: 'invalid' })); return;
    }
    const url = new URL(request.url, 'http://127.0.0.1');
    const supplied = Buffer.from(url.searchParams.get('state') ?? '');
    const expected = Buffer.from(state);
    const validState = supplied.length === expected.length && timingSafeEqual(supplied, expected);
    const keys = [...url.searchParams.keys()];
    if (settled || request.method !== 'GET' || url.pathname !== callbackPath || !validState || keys.some(key => url.searchParams.getAll(key).length !== 1) || (url.searchParams.has('iss') && url.searchParams.get('iss') !== issuer) || (url.searchParams.has('code') === url.searchParams.has('error'))) {
      response.writeHead(400).end(callbackPage({ kind: 'invalid' })); return;
    }
    settled = true;
    if (url.searchParams.has('error')) { response.end(callbackPage({ kind: 'denied' })); reject(new OAuthError('auth_denied', 'Authorization was not completed.')); return; }
    const authorizationCode = url.searchParams.get('code');
    if (!authorizationCode || authorizationCode.length > 16384 || /[\x00-\x20\x7f]/.test(authorizationCode)) { response.writeHead(400).end(callbackPage({ kind: 'invalid' })); reject(new OAuthError('auth_callback_invalid', 'The authorization callback is invalid.')); return; }
    response.end(callbackPage({ kind: 'received' })); accept(authorizationCode);
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise<void>((resolve, rejectListen) => {
    server.once('error', () => rejectListen(new OAuthError('auth_callback_unavailable', 'The registered callback port is unavailable. Close the process using it and retry.')));
    server.listen(savedRedirect ? Number(new URL(savedRedirect).port) : 0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') return fail('auth_callback_unavailable', 'The callback listener could not start.');
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rejectTimeout) => {
    timer = setTimeout(() => {
      const error = new OAuthError('auth_timeout', 'Authorization timed out. Run auth login again.');
      reject(error); rejectTimeout(error);
    }, timeoutMs);
  });
  void timeout.catch(() => {});
  return { redirectUri: `http://127.0.0.1:${address.port}${callbackPath}`, code, timeout, close: async () => { clearTimeout(timer); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

export function createCloudAuth(options: Options) {
  const resource = root(options.origin), fetcher = options.fetch ?? globalThis.fetch;
  const transaction = <T>(action: (key: string) => Promise<T>) => credentialTransaction({ stateDirectory: options.stateDirectory, resource, lockTimeoutMs: options.lockTimeoutMs ?? 10_000 }, action);
  const read = async (key: string) => { const raw = await options.credentialStore.read(key); return raw === null ? null : parseSession(raw, resource); };
  const write = async (key: string, session: Session) => {
    const raw = JSON.stringify(session);
    if (Buffer.byteLength(raw) > limit) return fail('auth_credentials_invalid', 'The credentials exceed the supported size.');
    await options.credentialStore.write(key, raw);
  };
  async function request(url: string, init: RequestInit = {}, mode: 'json' | 'revocation' = 'json'): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        void reader?.cancel().catch(() => {});
        reject(new OAuthError('auth_request_failed', 'The authentication request timed out.'));
      }, options.requestTimeoutMs ?? 15_000);
    });
    try {
      return await Promise.race([timeout, (async () => {
        const response = await fetcher(url, { ...init, redirect: 'error', signal: controller.signal });
        reader = response.body?.getReader();
        if (response.redirected || response.status >= 300 && response.status < 400) return fail('auth_redirect_rejected', 'Authentication redirects are not permitted for protocol requests.');
        controller.signal.throwIfAborted();
        if (mode === 'revocation') {
          if (response.status === 200) return {};
          if (response.status !== 400) return fail('auth_request_failed', 'The authentication server rejected the revocation request.');
        }
        let size = 0; const parts: Uint8Array[] = [];
        if (reader) for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > limit) return fail('auth_response_invalid', 'The authentication response exceeds the supported size.');
          parts.push(chunk.value);
        }
        controller.signal.throwIfAborted();
        const raw = Buffer.concat(parts).toString('utf8');
        const parsed = raw ? object(JSON.parse(raw)) : fail('auth_response_invalid', 'The authentication response is empty.');
        if (mode === 'revocation') return fail(parsed.error === 'invalid_grant' ? 'auth_revocation_invalid_grant' : 'auth_request_failed', 'The authentication server rejected the revocation request.');
        if (!response.ok) return fail(parsed.error === 'invalid_grant' ? 'auth_reauthorization_required' : 'auth_request_failed', parsed.error === 'invalid_grant' ? 'The authorization grant expired or was revoked. Run auth login again.' : 'The authentication server rejected the request.');
        return parsed;
      })()]);
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      return fail('auth_request_failed', 'The authentication request failed. Check the connection and retry the command.');
    } finally {
      clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
  }
  async function discover(): Promise<Metadata> {
    const protectedResource = await request(`${resource}/.well-known/oauth-protected-resource`);
    if (root(protectedResource.resource) !== resource || !Array.isArray(protectedResource.authorization_servers) || protectedResource.authorization_servers.length !== 1) return fail('auth_metadata_invalid', 'The resource must declare one matching authorization server.');
    const issuer = root(protectedResource.authorization_servers[0]);
    const metadata = await request(`${issuer}/.well-known/oauth-authorization-server`);
    if (root(metadata.issuer) !== issuer || !includes(metadata.response_types_supported, 'code') || !includes(metadata.grant_types_supported, 'authorization_code') || !includes(metadata.grant_types_supported, 'refresh_token') || !includes(metadata.token_endpoint_auth_methods_supported, 'none') || !includes(metadata.code_challenge_methods_supported, 'S256')) return fail('auth_metadata_invalid', 'The authorization server does not support the required public-client flow.');
    return { issuer, authorization: endpoint(metadata.authorization_endpoint, issuer), token: endpoint(metadata.token_endpoint, issuer), registration: endpoint(metadata.registration_endpoint, issuer), revocation: metadata.revocation_endpoint === undefined ? null : endpoint(metadata.revocation_endpoint, issuer) };
  }
  async function token(session: Session, parameters: Record<string, string>): Promise<Grant> {
    const reply = await request(session.metadata.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...parameters, client_id: session.registration.clientId, resource }) });
    if (typeof reply.token_type !== 'string' || reply.token_type.toLowerCase() !== 'bearer' || typeof reply.expires_in !== 'number' || !Number.isSafeInteger(reply.expires_in) || reply.expires_in <= 0 || reply.expires_in > 31_536_000) return fail('auth_response_invalid', 'The token response has an invalid type or expiry.');
    return { accessToken: text(reply.access_token), refreshToken: reply.refresh_token === undefined ? null : text(reply.refresh_token), expiresAt: Date.now() + reply.expires_in * 1000, scope: scope(reply.scope) };
  }
  function statusOf(session: Session | null): AuthStatus {
    const needsRefresh = !!session?.grant && session.grant.expiresAt <= Date.now() + 60_000;
    const refreshAvailable = !!session?.grant?.refreshToken;
    return { resource, issuer: session?.metadata.issuer ?? null, state: session === null ? 'logged_out' : session.grant === null || needsRefresh && !refreshAvailable ? 'reauthorization_required' : 'stored', expiresAt: session?.grant?.expiresAt ?? null, needsRefresh, refreshAvailable };
  }
  return {
    status: () => transaction(async key => statusOf(await read(key))),
    login: ({ showAuthorizationUrl }: { showAuthorizationUrl: (url: string) => void | Promise<void> }) => transaction(async key => {
      const metadata = await discover();
      const prior = await read(key);
      if (prior && prior.metadata.issuer !== metadata.issuer) return fail('auth_issuer_changed', 'The resource authorization server changed. Log out before authorizing the new server.');
      const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
      const callback = await loopback(prior?.registration.redirectUri ?? null, state, metadata.issuer, options.loginTimeoutMs ?? 300_000);
      try {
        let registration = prior?.registration;
        if (!registration) {
          const reply = await request(metadata.registration, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'polylinedb CLI', redirect_uris: [callback.redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
          if (reply.client_secret !== undefined || reply.token_endpoint_auth_method !== 'none' || !Array.isArray(reply.redirect_uris) || reply.redirect_uris.length !== 1 || reply.redirect_uris[0] !== callback.redirectUri) return fail('auth_registration_invalid', 'The server did not register the requested public client and callback.');
          registration = { clientId: text(reply.client_id), redirectUri: callback.redirectUri };
        }
        const session: Session = { version: 1, resource, metadata, registration, grant: null };
        if (!prior) await write(key, session);
        const url = new URL(metadata.authorization);
        url.search = new URLSearchParams({ client_id: registration.clientId, redirect_uri: registration.redirectUri, response_type: 'code', resource, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
        const code = await Promise.race([
          Promise.resolve().then(() => showAuthorizationUrl(url.href)).then(() => callback.code),
          callback.timeout,
        ]);
        const grant = await token(session, { grant_type: 'authorization_code', code, redirect_uri: registration.redirectUri, code_verifier: verifier });
        const authenticated = { ...session, grant }; await write(key, authenticated);
        return statusOf(authenticated);
      } finally { await callback.close(); }
    }),
    accessToken: () => transaction(async key => {
      const session = await read(key);
      if (!session?.grant) return fail('auth_reauthorization_required', 'Run auth login for this cloud connection.');
      if (session.grant.expiresAt > Date.now() + 60_000) return session.grant.accessToken;
      if (!session.grant.refreshToken) return fail('auth_reauthorization_required', 'The authorization grant expired. Run auth login again.');
      // A durable tombstone prevents another process from replaying a rotated token after a crash.
      await write(key, { ...session, grant: null });
      const refreshed = await token(session, { grant_type: 'refresh_token', refresh_token: session.grant.refreshToken });
      const grant = { ...refreshed, refreshToken: refreshed.refreshToken ?? session.grant.refreshToken, scope: refreshed.scope || session.grant.scope };
      await write(key, { ...session, grant });
      return grant.accessToken;
    }),
    logout: () => transaction(async key => {
      let revocation: 'not_needed' | 'revoked' | 'unsupported' | 'failed' = 'not_needed';
      try {
        const session = await read(key);
        if (session?.grant) {
          if (!session.metadata.revocation) revocation = 'unsupported';
          else {
            revocation = 'revoked';
            let refreshRevoked = false;
            const tokens: [string | null, string][] = [[session.grant.refreshToken, 'refresh_token'], [session.grant.accessToken, 'access_token']];
            for (const [tokenValue, hint] of tokens) {
              if (tokenValue) {
                try {
                  await request(session.metadata.revocation, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokenValue, token_type_hint: hint, client_id: session.registration.clientId }) }, 'revocation');
                  if (hint === 'refresh_token') refreshRevoked = true;
                } catch (error) {
                  // Cloudflare Access cascades refresh revocation and reports the subsequent access token as invalid_grant.
                  if (!(hint === 'access_token' && refreshRevoked && cloudflareAccessIssuer(session.metadata.issuer) && error instanceof OAuthError && error.code === 'auth_revocation_invalid_grant')) revocation = 'failed';
                }
              }
            }
          }
        }
      } catch { revocation = 'failed'; }
      await options.credentialStore.delete(key);
      return { resource, local: 'deleted' as const, revocation };
    }),
  };
}
