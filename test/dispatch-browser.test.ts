/** Presses Dispatch in a real headless browser and checks that the result shows on the page without a navigation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { storageOf } from 'solarsql/node';
import { SCHEMA_SQL } from '../src/records/persistence/schema.ts';
import { handleRequest } from '../src/service/index.ts';
import { createDispatcher } from '../src/service/dispatch.ts';

// The test needs a Chromium build. POLYLINEDB_TEST_CHROMIUM names one; otherwise common install paths are tried.
function findBrowser(): string | null {
  const playwright = existsSync('/opt/pw-browsers') ? readdirSync('/opt/pw-browsers').filter(name => name.startsWith('chromium_headless_shell-'))
    .map(name => `/opt/pw-browsers/${name}/chrome-linux/headless_shell`) : [];
  const candidates = [process.env.POLYLINEDB_TEST_CHROMIUM, ...playwright, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((path): path is string => typeof path === 'string' && path !== '' && existsSync(path)) ?? null;
}
const browserPath = findBrowser();

function store() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(SCHEMA_SQL);
  const storage = storageOf(sqlite);
  const prepare = (sql: string) => {
    const make = (params: (string | number | null)[]) => ({
      sql, params,
      bind: (...values: (string | number | null)[]) => make(values),
      all: async () => ({ success: true, results: storage.sql.exec(sql, ...params).toArray() }),
    });
    return make([]);
  };
  const DB = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(({ sql, params }) => ({ success: true, results: storage.sql.exec(sql, ...params).toArray() }));
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { sqlite, DB };
}

type Cdp = { send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>; close: () => void };
async function connect(url: string): Promise<Cdp> {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let next = 0;
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    if (typeof message.id === 'number') pending.get(message.id)?.(message);
  };
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} did not answer`)); }, 5_000);
      pending.set(id, message => { clearTimeout(timer); pending.delete(id); if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result as Record<string, unknown>); });
      socket.send(JSON.stringify({ id, method, params }));
    }),
    close: () => socket.close(),
  };
}

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

test('Dispatch sends in place: the page stays, the button waits, success clears the notes, failure keeps them', { timeout: 60_000, skip: browserPath === null ? 'no Chromium build found' : false }, async () => {
  const { sqlite, DB } = store();
  const received: string[] = [];
  let reply: (status: number) => void = () => {};
  const dispatcher = createDispatcher({
    fetch: async (_url, init) => {
      received.push(String(init?.body));
      const status = await new Promise<number>(resolve => { reply = resolve; });
      return new Response(null, { status });
    },
  });
  const env = { DB, ACCESS_TEAM_DOMAIN: 'polylinedb-test.cloudflareaccess.com', ACCESS_AUD: 'polylinedb-test', ACCESS_ACTORS: '["access:owner"]', ALLOWED_ORIGINS: '[]',
    POLYLINEDB_DISPATCH_WEBHOOK_URL: 'https://fixture.invalid/dispatch', POLYLINEDB_DISPATCH_WEBHOOK_KEY: 'fixture-key' };
  const authenticate = async () => ({ actor: { id: 'access:owner', kind: 'human' as const }, access: 'write' as const });
  const server: Server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value);
    const request = new Request(`http://${incoming.headers.host}${incoming.url}`, { method: incoming.method, headers, ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks) }) });
    const response = await handleRequest(request, env as never, authenticate as never, dispatcher);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const profile = mkdtempSync(join(tmpdir(), 'polylinedb-browser-'));
  const browser = spawn(browserPath!, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let cdp: Cdp | undefined;
  try {
    const created = await (await handleRequest(new Request(`${origin}/v1/operations`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'polylinedb', project: 'meganemura/polylinedb', body: 'Browser dispatch', labels: ['ready'] }) }), env as never, authenticate as never)).json() as { issue: { id: string } };
    const page = `${origin}/ui/i/${created.issue.id}`;
    const endpoint = await new Promise<string>((resolve, reject) => {
      let text = '';
      browser.stderr.on('data', chunk => { text += String(chunk); const match = /DevTools listening on (ws:\/\/\S+)/.exec(text); if (match) resolve(match[1]!); });
      browser.on('exit', code => reject(new Error(`browser exited ${code}: ${text}`)));
    });
    const targets = await (await fetch(`http://${new URL(endpoint).host}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
    cdp = await connect(targets.find(target => target.type === 'page')!.webSocketDebuggerUrl);
    const evaluate = async (expression: string) => ((await cdp!.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result as { value: unknown }).value;
    await cdp.send('Page.navigate', { url: page });
    const form = "document.querySelector('form[action$=\\'/dispatch\\']')";
    await until(() => evaluate(`document.readyState === 'complete' && !!${form}?.querySelector('[role=status]')`), Boolean, 'the issue page');
    const state = () => evaluate(`(() => { const f = ${form}; const b = f.querySelector('button'); const o = f.querySelector('[role=status]');
      return { href: location.href, disabled: b.disabled, label: b.textContent, icon: !!b.querySelector('svg'), notes: f.querySelector('textarea').value, result: o.textContent, state: o.dataset.state ?? '' }; })()`) as Promise<Record<string, unknown>>;

    await evaluate(`${form}.querySelector('textarea').value = 'Check the landing order'; ${form}.querySelector('button').click()`);
    const sending = await until(state, value => value.disabled === true, 'the sending state');
    assert.deepEqual({ label: sending.label, href: sending.href }, { label: 'Sending…', href: page });
    await evaluate(`${form}.querySelector('button').click()`);
    await until(async () => received.length, count => count === 1, 'the webhook post');
    reply(200);
    const sent = await until(state, value => value.state === 'ok', 'the success message');
    assert.equal(sent.result, 'Sent.');
    // The button gets its icon back with its label, so a send leaves the control as it was.
    assert.deepEqual({ href: sent.href, notes: sent.notes, disabled: sent.disabled, label: sent.label, icon: sent.icon }, { href: page, notes: '', disabled: false, label: 'Dispatch', icon: true });
    assert.equal(JSON.parse(received[0]!).notes, 'Check the landing order');
    assert.equal(received.length, 1);

    await evaluate(`${form}.querySelector('textarea').value = 'Second try'; ${form}.querySelector('button').click()`);
    const repeated = await until(state, value => value.state === 'error' || value.state === 'ok', 'the repeat result');
    assert.equal(repeated.state, 'error');
    assert.equal(repeated.result, 'This dispatch conflicts with the send already open for this issue.');
    assert.deepEqual({ href: repeated.href, notes: repeated.notes }, { href: page, notes: 'Second try' });
    assert.equal(received.length, 1);
  } finally {
    reply(503);
    cdp?.close();
    if (browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited; }
    rmSync(profile, { recursive: true, force: true });
    await new Promise(resolve => server.close(resolve));
    sqlite.close();
  }
});
