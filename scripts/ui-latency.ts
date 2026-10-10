// Measures /ui latency on the built Worker in local workerd with a synthetic D1 store and headless Chrome. See docs/ui-latency.md.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { Miniflare, Response as MiniflareResponse } from 'miniflare';
import { SCHEMA_STATEMENTS } from '../src/records/persistence.ts';

const { values: options } = parseArgs({ options: {
  'delay-ms': { type: 'string', default: '0' },
  'server-runs': { type: 'string', default: '40' },
  'browser-runs': { type: 'string', default: '5' },
  'dwell-ms': { type: 'string', default: '300' },
  chrome: { type: 'string', default: process.env.CHROME ?? 'google-chrome' },
  'skip-browser': { type: 'boolean', default: false },
  out: { type: 'string' },
} });
const delayMs = Number(options['delay-ms']);
const serverRuns = Number(options['server-runs']);
const browserRuns = Number(options['browser-runs']);
const dwellMs = Number(options['dwell-ms']);

const bundle = await readFile(new URL('../.cloudflare/output/v0/workers/default/bundle/index.js', import.meta.url), 'utf8');
const issuer = 'https://polylinedb-latency.cloudflareaccess.com';
const audience = 'polylinedb-latency';
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);

async function assertion(): Promise<string> {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'RS256', kid: 'latency' })}.${encode({ iss: issuer, aud: [audience], sub: 'owner', iat: now - 1, exp: now + 3600 })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${Buffer.from(signature).toString('base64url')}`;
}

// Deterministic, so every run measures the same store.
let seed = 0x5eed;
function random(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const words = 'store claim lease worker access page phone project label issue comment blocker parent child search index render cache network latency queue main merge release schema snapshot memory agent owner review deploy budget frame paint navigation filter chip theme night'.split(' ');
const sentence = () => {
  const text = Array.from({ length: 6 + Math.floor(random() * 14) }, () => pick(words)).join(' ');
  return `${text[0]?.toUpperCase()}${text.slice(1)}.`;
};
const paragraph = () => Array.from({ length: 1 + Math.floor(random() * 4) }, sentence).join(' ');

const projects = [
  ['polylinedb', 'example/polylinedb', 320], ['nukadoko', 'example/nukadoko', 180], ['compiler', 'example/parser', 120],
  ['compiler', 'example/linker', 90], ['notes', 'example/garden', 80], ['site', 'example/blog', 60],
  ['infra', 'example/dns', 50], ['infra', 'example/backups', 40], ['phone', 'example/shortcuts', 35], ['misc', 'example/inbox', 25],
] as const;

// Visible time is activation-adjusted first contentful paint, as web-vitals reports it.
// A back-forward cache restore has no new navigation entry, so it is timed from history.back() to the frame after pageshow.
const restoreProbe = "addEventListener('pageshow', event => { if (event.persisted) requestAnimationFrame(() => { window.__shownAt = performance.timeOrigin + performance.now(); }); })";
const navigationProbe = `(() => {
  if (window.__shownAt !== undefined) return { restoredFrom: 'bfcache', shownAt: window.__shownAt, responseStartMs: 0 };
  const entry = performance.getEntriesByType('navigation')[0];
  const paint = performance.getEntriesByName('first-contentful-paint')[0];
  const activation = entry.activationStart ?? 0;
  const restoredFrom = activation > 0 ? 'prerender' : entry.deliveryType === 'navigational-prefetch' ? 'prefetch' : entry.transferSize === 0 && entry.decodedBodySize > 0 ? 'http-cache' : entry.transferSize < 1000 && entry.decodedBodySize > 0 ? 'revalidated' : 'network';
  return { restoredFrom, visibleMs: paint ? Math.max(paint.startTime - activation, 0) : null, responseStartMs: Math.max(entry.responseStart - activation, 0), transferSize: entry.transferSize };
})()`;

const runtime = new Miniflare({
  host: '127.0.0.1', port: 0, cf: false, telemetry: { enabled: false },
  workers: [{
    config: {
      name: 'polylinedb-latency', compatibilityDate: '2026-09-25',
      manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: bundle } } },
      env: {
        DB: { type: 'd1', name: 'polylinedb-latency' },
        ACCESS_TEAM_DOMAIN: { type: 'text', value: 'polylinedb-latency.cloudflareaccess.com' },
        ACCESS_AUD: { type: 'text', value: audience },
        ACCESS_ACTORS: { type: 'text', value: JSON.stringify([{ actor: 'access:owner', role: 'human', label: 'owner' }]) },
        ALLOWED_ORIGINS: { type: 'text', value: '[]' },
      },
    },
    dev: { unsafeRegisterWorker: false, outboundService: { type: 'fetcher', handler: () => MiniflareResponse.json({ keys: [{ ...publicKey, kid: 'latency', alg: 'RS256', use: 'sig' }] }) } },
  }],
});

const cleanups: (() => Promise<unknown>)[] = [() => runtime.dispose()];
try {
  const origin = await runtime.ready;
  const database = await runtime.getD1Database('DB');
  await database.batch(SCHEMA_STATEMENTS.map(sql => database.prepare(sql)));
  const token = await assertion();
  const operation = async (body: Record<string, unknown>): Promise<Record<string, any>> => {
    const response = await runtime.dispatchFetch(new URL('/v1/operations', origin), { method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': token }, body: JSON.stringify(body) });
    const output = await response.json() as Record<string, any>;
    assert.equal(response.status, 200, JSON.stringify(output));
    return output;
  };
  const inParallel = async <T>(items: readonly T[], work: (item: T) => Promise<unknown>) => {
    for (let index = 0; index < items.length; index += 16) await Promise.all(items.slice(index, index + 16).map(work));
  };

  const started = performance.now();
  type Seeded = { id: string; tool: string; project: string; status: string };
  const issues: Seeded[] = [];
  const epics: string[] = [];
  for (const [tool, project, size] of projects) {
    const scoped: Seeded[] = [];
    for (let index = 0; index < 2; index += 1) {
      const epic = (await operation({ op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool, project, type: 'epic', body: `# Epic ${sentence()}\n\n${paragraph()}` })).issue.id;
      epics.push(epic);
      scoped.push({ id: epic, tool, project, status: 'open' });
    }
    const fields = Array.from({ length: size - 2 }, (_, index) => {
      const roll = random();
      const status = roll < 0.55 ? 'closed' : roll < 0.83 ? 'open' : roll < 0.9 ? 'in_progress' : 'deferred';
      const labels = (['ready', 'main-wait', 'owner-decision', 'owner-action', 'dogfood'] as const).filter((_, at) => random() < [0.15, 0.03, 0.03, 0.02, 0.05][at]!);
      const parent = index < 30 ? scoped[index % 2]!.id : undefined;
      return { op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool, project, status, labels, priority: Math.floor(random() * 5),
        type: pick(['task', 'bug', 'feature', 'chore']), body: `# ${sentence()}\n\n${Array.from({ length: 1 + Math.floor(random() * 5) }, paragraph).join('\n\n')}`,
        ...(parent === undefined ? {} : { parent }) };
    });
    await inParallel(fields, async body => {
      const issue = (await operation(body)).issue;
      scoped.push({ id: issue.id, tool, project, status: issue.status });
    });
    issues.push(...scoped);
  }
  const comments = issues.flatMap(issue => Array.from({ length: Math.floor(random() * 5) }, () => ({ op: 'comment', id: issue.id, body: paragraph() })));
  for (const epic of epics.slice(0, 2)) for (let index = 0; index < 12; index += 1) comments.push({ op: 'comment', id: epic, body: Array.from({ length: 3 }, paragraph).join('\n\n') });
  await inParallel(comments, operation);
  const edges = new Map<string, string[]>();
  // A blocker always comes earlier in creation order, except under the first epic, which blocks nothing, so the graph has no cycle.
  for (let index = 0; index < 250; index += 1) {
    const [tool] = pick(projects);
    const scoped = issues.filter(issue => issue.tool === tool && issue.id !== epics[0]);
    const [first, second] = [pick(scoped), pick(scoped)].sort((a, b) => issues.indexOf(a) - issues.indexOf(b));
    const dependent = index < 4 ? epics[0]! : second!.id;
    const blocker = first!.id;
    if (dependent === blocker || edges.get(dependent)?.includes(blocker)) continue;
    edges.set(dependent, [...(edges.get(dependent) ?? []), blocker]);
  }
  for (const [dependent, blockers] of edges) {
    for (const blocker of blockers) {
      const { revision } = await operation({ op: 'dependency_list', dependent_id: dependent });
      await operation({ op: 'dependency_add', dependent_id: dependent, blocker_id: blocker, expected_revision: revision, request_id: crypto.randomUUID() });
    }
  }
  const claimable = issues.filter(issue => issue.status === 'open' || issue.status === 'in_progress').slice(0, 400).filter(() => random() < 0.08);
  await inParallel(claimable, async issue => {
    const { claim } = await operation({ op: 'claim_show', issue_id: issue.id });
    await operation({ op: 'claim_acquire', issue_id: issue.id, incarnation: claim.store_incarnation, session_id: crypto.randomUUID(), request_id: crypto.randomUUID(), ttl: 3600, agent_label: pick(['Codex', 'Claude', null]) });
  });
  const now = Date.now();
  await database.batch(issues.map(issue => database.prepare('UPDATE issues SET updated_at = ? WHERE id = ?')
    .bind(new Date(now - Math.floor(random() * 90 * 86_400_000)).toISOString(), issue.id)));
  const counts = { projects: projects.length, issues: issues.length, comments: comments.length, dependencies: [...edges.values()].flat().length, activeClaims: claimable.length };
  process.stderr.write(`seeded ${JSON.stringify(counts)} in ${Math.round(performance.now() - started)} ms\n`);

  const largest = projects[0];
  const projectPath = `/ui/p/${largest[0]}/${largest[1]}`;
  const pages: Record<string, string> = {
    home: '/ui', inbox: '/ui/inbox', working: '/ui/working', blocked: '/ui/blocked', recent: '/ui/recent',
    project: projectPath, 'project open': `${projectPath}?status=open`, 'project ready': `${projectPath}?label=ready`,
    'issue (epic)': `/ui/i/${epics[0]}`, 'issue (leaf)': `/ui/i/${issues.find(issue => issue.status === 'closed')!.id}`,
    'search words': '/ui/search?q=lease%20worker', 'search id': `/ui/search?q=${issues[500]!.id}`,
  };
  const quantile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(q * values.length))]!;
  const round = (value: number) => Math.round(value * 10) / 10;
  const server: Record<string, unknown>[] = [];
  for (const [name, path] of Object.entries(pages)) {
    const times: number[] = [];
    let html = '';
    let etag: string | null = null;
    let timing: string | null = null;
    for (let run = -3; run < serverRuns; run += 1) {
      const begin = performance.now();
      const response = await runtime.dispatchFetch(new URL(path, origin), { headers: { 'cf-access-jwt-assertion': token } });
      html = await response.text();
      if (run >= 0) times.push(performance.now() - begin);
      assert.equal(response.status, 200, `${name}: ${response.status}`);
      etag = response.headers.get('etag');
      timing = response.headers.get('server-timing');
    }
    const revalidated: number[] = [];
    let revalidatedStatus: number | null = null;
    if (etag !== null) {
      for (let run = 0; run < serverRuns; run += 1) {
        const begin = performance.now();
        const response = await runtime.dispatchFetch(new URL(path, origin), { headers: { 'cf-access-jwt-assertion': token, 'if-none-match': etag } });
        await response.arrayBuffer();
        revalidated.push(performance.now() - begin);
        revalidatedStatus = response.status;
      }
    }
    server.push({ page: name, path, medianMs: round(quantile(times, 0.5)), p95Ms: round(quantile(times, 0.95)), bytes: Buffer.byteLength(html), gzipBytes: gzipSync(html).byteLength,
      ...(etag === null ? {} : { revalidatedStatus, revalidatedMedianMs: round(quantile(revalidated, 0.5)) }), ...(timing === null ? {} : { serverTiming: timing }) });
  }
  console.table(server);

  const browser: Record<string, unknown>[] = [];
  if (!options['skip-browser']) {
    // Plays the Access edge: it adds the assertion to every request, as Access does after its own login check.
    const proxy = createServer((incoming, outgoing) => {
      setTimeout(() => {
        const upstream = httpRequest(new URL(incoming.url ?? '/', origin), { method: incoming.method, headers: { ...incoming.headers, 'cf-access-jwt-assertion': token } }, response => {
          outgoing.writeHead(response.statusCode ?? 502, response.headers);
          response.pipe(outgoing);
        });
        incoming.pipe(upstream);
      }, delayMs);
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise(resolve => proxy.close(resolve)));
    const address = proxy.address();
    assert.ok(address !== null && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const profile = await mkdtemp(join(tmpdir(), 'ui-latency-'));
    cleanups.push(() => rm(profile, { recursive: true, force: true }));
    const chrome = spawn(options.chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--window-size=420,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    cleanups.unshift(async () => { chrome.kill(); await new Promise(resolve => chrome.once('exit', resolve)); });
    const endpoint = await new Promise<string>((resolve, reject) => {
      let output = '';
      chrome.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        const found = /DevTools listening on (ws:\/\/\S+)/.exec(output);
        if (found?.[1] !== undefined) resolve(found[1]);
      });
      chrome.once('exit', code => reject(new Error(`Chrome exited with ${code}`)));
    });
    const cdp = await connect(endpoint);
    for (let run = 0; run < browserRuns; run += 1) {
      for (const dwell of [dwellMs, 0]) browser.push(...await scenario(cdp, base, projectPath, dwell, run));
    }
    cdp.close();
    const steps = [...new Set(browser.map(row => `${row.step}`))];
    const summary = steps.flatMap(step => [dwellMs, 0].map(dwell => {
      const rows = browser.filter(row => row.step === step && row.dwellMs === dwell);
      const visible = rows.map(row => Number(row.visibleMs));
      return { step, dwellMs: dwell, medianVisibleMs: round(quantile(visible, 0.5)), maxVisibleMs: round(Math.max(...visible)),
        restoredFrom: [...new Set(rows.map(row => row.restoredFrom))].join(' ') };
    }));
    console.table(summary);
    browser.push(...summary.map(row => ({ summary: true, ...row })));
  }
  if (options.out !== undefined) await writeFile(options.out, `${JSON.stringify({ delayMs, dwellMs, counts, server, browser }, null, 2)}\n`);
} finally {
  for (const cleanup of cleanups) await cleanup();
}

type Message = { id?: number; method?: string; params?: Record<string, any>; result?: Record<string, any>; error?: { message: string }; sessionId?: string };
type Cdp = Awaited<ReturnType<typeof connect>>;

async function connect(url: string) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let next = 0;
  const pending = new Map<number, { resolve: (value: Record<string, any>) => void; reject: (error: Error) => void }>();
  const listeners = new Set<(message: Message) => void>();
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data)) as Message;
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message));
      else waiter?.resolve(message.result ?? {});
      return;
    }
    for (const listener of listeners) listener(message);
  };
  return {
    send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, any>> {
      const id = ++next;
      socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(listener: (message: Message) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => socket.close(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function scenario(cdp: Cdp, base: string, projectPath: string, dwell: number, run: number): Promise<Record<string, unknown>[]> {
  const { browserContextId } = await cdp.send('Target.createBrowserContext');
  await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const tab = (targetInfos as { targetId: string; browserContextId: string }[]).find(info => info.browserContextId === browserContextId);
  assert.ok(tab);
  // Chrome prerenders only for a client attached through the tab, because activation swaps the page target.
  const { sessionId: tabSession } = await cdp.send('Target.attachToTarget', { targetId: tab.targetId, flatten: true });
  const pages = new Set<string>();
  const stop = cdp.on(message => {
    if (message.sessionId !== tabSession) return;
    if (message.method === 'Target.attachedToTarget') pages.add(message.params?.sessionId);
    if (message.method === 'Target.detachedFromTarget') pages.delete(message.params?.sessionId);
  });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, tabSession);
  let sessionId = '';
  const rows: Record<string, unknown>[] = [];
  const settle = async (url: string) => {
    for (let attempt = 0; attempt < 2000; attempt += 1) {
      for (const candidate of pages) {
        try {
          const { result } = await cdp.send('Runtime.evaluate', { expression: "!document.prerendering && document.readyState === 'complete' && location.href", returnByValue: true }, candidate);
          if (result.value === url) { sessionId = candidate; return; }
        } catch { /* A page session closes when the tab swaps pages. */ }
      }
      await sleep(5);
    }
    throw new Error(`Navigation to ${url} did not settle`);
  };
  const measure = async (step: string, url: string, leftAt?: number) => {
    await settle(url);
    await sleep(50);
    const { result } = await cdp.send('Runtime.evaluate', { expression: navigationProbe, returnByValue: true }, sessionId);
    const shown = result.value as Record<string, unknown>;
    rows.push({ run, dwellMs: dwell, step, ...shown, ...(shown.restoredFrom === 'bfcache' && leftAt !== undefined ? { visibleMs: Number(shown.shownAt) - leftAt } : {}) });
    await cdp.send('Runtime.evaluate', { expression: restoreProbe }, sessionId);
  };
  const follow = async (step: string, selector: string) => {
    // The crossfade covers the new page for its duration, and a click during it does not reach the link.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.getAnimations().some(animation => animation.playState === "running")', returnByValue: true }, sessionId);
      if (result.value !== true) break;
      await sleep(20);
    }
    const { result } = await cdp.send('Runtime.evaluate', { expression: `(() => { const link = document.querySelector(${JSON.stringify(selector)}); link.scrollIntoView({ block: 'center' }); const box = link.getBoundingClientRect(); return { x: box.left + Math.min(box.width / 2, 40), y: box.top + box.height / 2, href: link.href }; })()`, returnByValue: true }, sessionId);
    const { x, y, href } = result.value as { x: number; y: number; href: string };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
    await sleep(dwell);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
    await measure(step, href);
  };
  await settle('about:blank');
  await cdp.send('Page.navigate', { url: `${base}/ui` }, sessionId);
  await measure('first load: home', `${base}/ui`);
  await sleep(500);
  await follow('home -> project', `a[href="${projectPath}"]`);
  await follow('project -> open filter', 'nav[aria-label="Status"] a[href$="?status=open"]');
  await follow('filter -> issue', '.quiet-list a[href^="/ui/i/"]');
  await cdp.send('Page.enable', {}, sessionId);
  const skipped = new Promise<string | undefined>(resolve => {
    const done = cdp.on(message => {
      if (message.method !== 'Page.backForwardCacheNotUsed') return;
      done();
      resolve((message.params?.notRestoredExplanations as { reason: string }[]).map(explanation => explanation.reason).join(' '));
    });
    setTimeout(() => { done(); resolve(undefined); }, 3000);
  });
  const { result } = await cdp.send('Runtime.evaluate', { expression: 'performance.timeOrigin + performance.now() + (history.back(), 0)', returnByValue: true }, sessionId);
  await measure('issue -> back', `${base}${projectPath}?status=open`, Number(result.value));
  const reasons = await skipped;
  if (reasons !== undefined) rows.at(-1)!.bfcacheSkipped = reasons;
  await follow('back -> inbox', '.views a[href="/ui/inbox"]');
  await follow('inbox -> issue', '.quiet-list a[href^="/ui/i/"]');
  await follow('issue -> home', '.views a[href="/ui"]');
  stop();
  await cdp.send('Target.disposeBrowserContext', { browserContextId });
  return rows;
}
