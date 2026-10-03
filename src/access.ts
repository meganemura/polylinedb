/** Verifies Access assertions and owner policy before issue operations receive an actor. */
export interface AccessSettings {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ACCESS_ACTORS: string;
}

export class AccessError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(status === 401 ? 'Authentication required' : status === 403 ? 'Access denied' : 'Authentication unavailable');
    this.name = 'AccessError';
    this.status = status;
    this.code = code;
  }
}

type Configuration = { issuer: string; audience: string; actors: ReadonlySet<string> };
type Keys = { issuer: string; expires: number; keys: ReadonlyMap<string, CryptoKey> };
const unauthorized = () => new AccessError(401, 'invalid_assertion');
const infrastructure = () => new AccessError(503, 'jwks_unavailable');

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw unauthorized();
  return value as Record<string, unknown>;
}

function configuration(settings: AccessSettings): Configuration {
  try {
    if (!settings || typeof settings.ACCESS_TEAM_DOMAIN !== 'string'
      || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(settings.ACCESS_TEAM_DOMAIN)
      || typeof settings.ACCESS_AUD !== 'string' || settings.ACCESS_AUD.trim() !== settings.ACCESS_AUD
      || settings.ACCESS_AUD.length === 0 || settings.ACCESS_AUD.length > 256
      || typeof settings.ACCESS_ACTORS !== 'string' || settings.ACCESS_ACTORS.length > 32768) throw new Error();
    const actors: unknown = JSON.parse(settings.ACCESS_ACTORS);
    if (!Array.isArray(actors) || actors.length === 0 || actors.length > 64
      || !actors.every((actor: unknown) => typeof actor === 'string'
        && /^(access|service):\S+$/.test(actor) && actor.length <= 512)) throw new Error();
    return { issuer: `https://${settings.ACCESS_TEAM_DOMAIN}`, audience: settings.ACCESS_AUD, actors: new Set(actors) };
  } catch {
    throw new AccessError(503, 'invalid_access_configuration');
  }
}

function bytes(segment: string): Uint8Array<ArrayBuffer> {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment) || segment.length % 4 === 1) throw unauthorized();
  try {
    return Uint8Array.from(atob(segment.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0));
  } catch { throw unauthorized(); }
}

function jsonSegment(segment: string): Record<string, unknown> {
  try { return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes(segment)))); }
  catch { throw unauthorized(); }
}

function actorFrom(claims: Record<string, unknown>, config: Configuration): string {
  const now = Math.floor(Date.now() / 1000);
  const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
  const audience = claims.aud;
  if (claims.iss !== config.issuer
    || !(typeof audience === 'string' ? audience === config.audience
      : Array.isArray(audience) && audience.length > 0
        && audience.every(item => typeof item === 'string' && item.length > 0) && audience.includes(config.audience))
    || !validTime(claims.exp) || claims.exp <= now
    || ('nbf' in claims && (!validTime(claims.nbf) || claims.nbf > now))
    || ('iat' in claims && (!validTime(claims.iat) || claims.iat > now))
    || ('sub' in claims && typeof claims.sub !== 'string')
    || ('common_name' in claims && typeof claims.common_name !== 'string')) throw unauthorized();
  const identity = typeof claims.sub === 'string' && claims.sub.length > 0
    ? { prefix: 'access:', value: claims.sub }
    : { prefix: 'service:', value: claims.common_name };
  if (typeof identity.value !== 'string' || !/^\S+$/.test(identity.value) || identity.value.length > 256) throw unauthorized();
  return identity.prefix + identity.value;
}

async function trustedKeys(response: Response, signal: AbortSignal): Promise<ReadonlyMap<string, CryptoKey>> {
  if (!response.ok || response.body === null) throw infrastructure();
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 128 * 1024) throw infrastructure();
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  const data = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)));
  if (!Array.isArray(data.keys) || data.keys.length === 0 || data.keys.length > 64) throw infrastructure();
  const keys = new Map<string, CryptoKey>();
  for (const value of data.keys) {
    const key = record(value);
    if (key.kty !== 'RSA' || ('alg' in key && key.alg !== 'RS256') || ('use' in key && key.use !== 'sig')) continue;
    if (typeof key.kid !== 'string' || key.kid.length === 0 || key.kid.length > 128
      || typeof key.n !== 'string' || key.n.length > 2048 || typeof key.e !== 'string' || key.e.length > 16
      || 'd' in key || keys.has(key.kid)) throw infrastructure();
    const modulus = bytes(key.n);
    if (modulus.byteLength < 256 || modulus.byteLength > 1024 || modulus[0] === 0) throw infrastructure();
    const publicKey: JsonWebKey = { kty: 'RSA', n: key.n, e: key.e, alg: 'RS256', ext: true, key_ops: ['verify'] };
    keys.set(key.kid, await crypto.subtle.importKey('jwk', publicKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  if (keys.size === 0) throw infrastructure();
  return keys;
}

export function createAccessVerifier(fetcher: typeof fetch = fetch): (request: Request, settings: AccessSettings) => Promise<string> {
  let cached: Keys | undefined;
  let loading: { issuer: string; promise: Promise<Keys> } | undefined;
  let unknownRefresh: { issuer: string; at: number } | undefined;

  async function load(issuer: string): Promise<Keys> {
    if (loading?.issuer === issuer) return loading.promise;
    const promise = (async () => {
      const signal = AbortSignal.timeout(5000);
      const timeout = new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(infrastructure()), { once: true });
      });
      const work = (async () => {
        const response = await fetcher(`${issuer}/cdn-cgi/access/certs`, { signal, redirect: 'manual' });
        return trustedKeys(response, signal);
      })();
      try {
        const keys = await Promise.race([work, timeout]);
        const result = { issuer, keys, expires: Date.now() + 300000 };
        cached = result;
        return result;
      } catch { throw infrastructure(); }
    })();
    loading = { issuer, promise };
    try { return await promise; }
    finally { if (loading?.promise === promise) loading = undefined; }
  }

  return async (request, settings) => {
    const config = configuration(settings);
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token || token.length > 32768) throw unauthorized();
    const segments = token.split('.');
    if (segments.length !== 3) throw unauthorized();
    const [headerPart, claimPart, signaturePart] = segments;
    const header = jsonSegment(headerPart);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length === 0 || header.kid.length > 128
      || 'crit' in header) throw unauthorized();
    const claims = jsonSegment(claimPart);
    const signature = bytes(signaturePart);
    let entry = cached?.issuer === config.issuer && cached.expires > Date.now() ? cached : await load(config.issuer);
    let key = entry.keys.get(header.kid);
    if (!key) {
      if (unknownRefresh?.issuer !== config.issuer || Date.now() - unknownRefresh.at >= 30000) {
        unknownRefresh = { issuer: config.issuer, at: Date.now() };
        entry = await load(config.issuer);
        key = entry.keys.get(header.kid);
      }
      if (!key) throw unauthorized();
    }
    let valid = false;
    try {
      valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, new TextEncoder().encode(`${headerPart}.${claimPart}`));
    } catch { throw unauthorized(); }
    if (!valid) throw unauthorized();
    const actor = actorFrom(claims, config);
    if (!config.actors.has(actor)) throw new AccessError(403, 'actor_not_allowed');
    return actor;
  };
}
