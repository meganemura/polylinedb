/** Decides and delivers one Dispatch press. HTML stays in the page renderer. */
import type { Caller } from './access.ts';
import { d1Executor, type D1DatabaseLike } from './d1.ts';
import { issueDispatchScope } from '../records/index.ts';

export const dispatchSecretNames = ['POLYLINEDB_DISPATCH_WEBHOOK_URL', 'POLYLINEDB_DISPATCH_WEBHOOK_KEY'] as const;

export type DispatchControl = 'ready' | 'unavailable' | 'hidden';

export type DispatchOutcome =
  | { kind: 'sent' }
  | { kind: 'already_sent'; phase: 'in_flight' | 'delivered' }
  | { kind: 'retried'; delivered: boolean }
  | { kind: 'not_sent' }
  | { kind: 'conflict' }
  | { kind: 'unavailable' }
  | { kind: 'not_permitted' }
  | { kind: 'not_found' }
  | { kind: 'invalid_form' };

type DispatchSettings = { [Name in (typeof dispatchSecretNames)[number]]?: string };
type DispatchEnv = DispatchSettings & { DB: D1DatabaseLike };

export type Dispatcher = {
  control(env: DispatchSettings, caller: Caller): DispatchControl;
  press(request: Request, env: DispatchEnv, caller: Caller, issueId: string): Promise<DispatchOutcome>;
};

export type DispatcherOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  readScope?: (database: D1DatabaseLike, issueId: string) => Promise<{ tool: string; project: string } | null>;
  newEventId?: () => string;
};

const windowMs = 60_000;
const defaultTimeoutMs = 10_000;
const formLimitBytes = 16 * 1024;
const notesLimitBytes = 4096;
const eventIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Envelope = {
  intent: 'dispatch';
  project: string;
  issue_id: string;
  event_id: string;
  idempotency_key: `${string}:dispatch`;
  occurred_at: number;
  notes?: string;
};

type Send = {
  envelope: Envelope;
  openedAt: number;
  attempt: number;
  delivery: 'in_flight' | 'delivered' | 'failed';
};

type Press = { project: string; issueId: string; notes: string | undefined };

type Decision =
  | { kind: 'post'; send: Send; retry: boolean }
  | { kind: 'hold'; send: Send; because: 'in_flight' | 'delivered' | 'conflict' };

function mayPress(caller: Caller): boolean {
  return caller.actor.kind === 'human' && caller.access === 'write' && caller.actor.id.startsWith('access:');
}

function webhookFrom(env: DispatchSettings): { url: string; key: string } | undefined {
  const urlValue = env.POLYLINEDB_DISPATCH_WEBHOOK_URL;
  const key = env.POLYLINEDB_DISPATCH_WEBHOOK_KEY;
  if (typeof urlValue !== 'string' || typeof key !== 'string') return undefined;
  if (urlValue.trim() === '' || key.trim() === '' || !/^\S+$/.test(key)) return undefined;
  let url: URL;
  try { url = new URL(urlValue); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
  return { url: url.href, key };
}

function controlFor(env: DispatchSettings, caller: Caller): DispatchControl {
  if (!mayPress(caller)) return 'hidden';
  return webhookFrom(env) === undefined ? 'unavailable' : 'ready';
}

function normalizeNotes(value: string): string | undefined | 'invalid' {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (normalized.length === 0) return undefined;
  if (new TextEncoder().encode(normalized).length > notesLimitBytes) return 'invalid';
  if (/[\p{Cc}]/u.test(normalized.replace(/[\n\t]/g, ''))) return 'invalid';
  return normalized;
}

async function readBody(request: Request): Promise<Uint8Array | 'invalid'> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > formLimitBytes) return 'invalid';
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > formLimitBytes) {
        await reader.cancel();
        return 'invalid';
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function readPressForm(request: Request): Promise<{ notes: string | undefined } | 'invalid'> {
  const bytes = await readBody(request);
  if (bytes === 'invalid') return 'invalid';
  if (bytes.byteLength === 0) return { notes: undefined };
  const media = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (media !== 'application/x-www-form-urlencoded') return 'invalid';
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return 'invalid'; }
  const params = new URLSearchParams(text);
  const names = [...params.keys()];
  if (new Set(names).size !== names.length || names.some(name => name !== 'notes')) return 'invalid';
  const raw = params.get('notes');
  if (raw === null) return { notes: undefined };
  const notes = normalizeNotes(raw);
  if (notes === 'invalid') return 'invalid';
  return { notes };
}

function sendKey(project: string, issueId: string): string {
  return JSON.stringify([project, issueId]);
}

function eventIdFrom(mint: () => string): string {
  const value = mint();
  if (!eventIdPattern.test(value)) throw new Error('Dispatch event id is not a lowercase UUID');
  return value;
}

function envelopeFor(press: Press, eventId: string, openedAt: number): Envelope {
  return {
    intent: 'dispatch',
    project: press.project,
    issue_id: press.issueId,
    event_id: eventId,
    idempotency_key: `${press.issueId}:dispatch`,
    occurred_at: Math.floor(openedAt / 1000),
    ...(press.notes === undefined ? {} : { notes: press.notes }),
  };
}

function decide(current: Send | undefined, press: Press, now: number, eventId: string): Decision {
  if (current === undefined || now - current.openedAt >= windowMs) {
    return { kind: 'post', retry: false, send: { envelope: envelopeFor(press, eventId, now), openedAt: now, attempt: 1, delivery: 'in_flight' } };
  }
  if ((current.envelope.notes ?? undefined) !== press.notes) return { kind: 'hold', send: current, because: 'conflict' };
  if (current.delivery === 'failed') {
    return { kind: 'post', retry: true, send: { ...current, attempt: current.attempt + 1, delivery: 'in_flight' } };
  }
  return { kind: 'hold', send: current, because: current.delivery };
}

function settle(current: Send | undefined, attempted: Send, delivered: boolean): Send | undefined {
  if (current === undefined || current.envelope.event_id !== attempted.envelope.event_id || current.attempt !== attempted.attempt) return undefined;
  return { ...current, delivery: delivered ? 'delivered' : 'failed' };
}

function prune(sends: Map<string, Send>, now: number): void {
  for (const [key, send] of sends) if (now - send.openedAt >= windowMs) sends.delete(key);
}

async function deliver(fetcher: typeof fetch, url: string, key: string, body: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ok = response.status >= 200 && response.status <= 299 && response.type !== 'opaqueredirect';
    try { await response.body?.cancel(); } catch { /* a discarded body does not change the delivery */ }
    return ok;
  } catch {
    return false;
  }
}

function heldOutcome(decision: Extract<Decision, { kind: 'hold' }>): DispatchOutcome {
  if (decision.because === 'conflict') return { kind: 'conflict' };
  return { kind: 'already_sent', phase: decision.because };
}

export function createDispatcher(options: DispatcherOptions = {}): Dispatcher {
  const sends = new Map<string, Send>();
  const fetcher = options.fetch ?? fetch;
  const clock = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const readScope = options.readScope ?? ((database: D1DatabaseLike, issueId: string) => issueDispatchScope(d1Executor(database), issueId));
  const mintEventId = options.newEventId ?? (() => crypto.randomUUID());
  return {
    control: controlFor,
    async press(request, env, caller, issueId) {
      if (!mayPress(caller)) return { kind: 'not_permitted' };
      const webhook = webhookFrom(env);
      if (webhook === undefined) return { kind: 'unavailable' };
      const form = await readPressForm(request);
      if (form === 'invalid') return { kind: 'invalid_form' };
      const scope = await readScope(env.DB, issueId);
      if (scope === null) return { kind: 'not_found' };
      const now = clock();
      prune(sends, now);
      const press = { project: `${scope.tool}/${scope.project}`, issueId, notes: form.notes };
      const decision = decide(sends.get(sendKey(press.project, issueId)), press, now, eventIdFrom(mintEventId));
      // The map is updated before the webhook await so another press in this isolate sees the in-flight send.
      if (decision.kind === 'post') sends.set(sendKey(press.project, issueId), decision.send);
      if (decision.kind === 'hold') return heldOutcome(decision);
      const delivered = await deliver(fetcher, webhook.url, webhook.key, JSON.stringify(decision.send.envelope), timeoutMs);
      const settled = settle(sends.get(sendKey(press.project, issueId)), decision.send, delivered);
      if (settled !== undefined) sends.set(sendKey(press.project, issueId), settled);
      if (decision.retry) return { kind: 'retried', delivered };
      return delivered ? { kind: 'sent' } : { kind: 'not_sent' };
    },
  };
}
