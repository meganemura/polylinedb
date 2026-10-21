import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gatePasses, judge, pageFacts, runGate, type BudgetVerdict, type PageFacts } from '../scripts/ui-latency-budget.ts';

const facts: PageFacts = { prefetchCoversUi: true, bfcacheEligible: true, viewTransitionMs: 80 };

const passing: BudgetVerdict[] = [
  { name: 'first load', kind: 'first-load', budgetMs: null, visibleMs: null, toleranceMs: 0, pass: true },
  { name: 'follow a link', kind: 'link', budgetMs: 100, visibleMs: 80, toleranceMs: 0, pass: true },
  { name: 'go back', kind: 'history', budgetMs: 16, visibleMs: 16, toleranceMs: 0, pass: true },
  { name: 'go forward', kind: 'history', budgetMs: 16, visibleMs: 16, toleranceMs: 0, pass: true },
  { name: 'submit a search', kind: 'search', budgetMs: null, visibleMs: null, toleranceMs: 0, pass: true },
];

test('the current /ui pages meet the latency budget', async () => {
  const report = await runGate();
  assert.equal(gatePasses(report), true);
  assert.deepEqual(report.verdicts, passing);
  assert.deepEqual(report.pages.map(page => [page.path, page.cacheControl, page.facts]), [
    ['/ui', 'private, no-cache', facts],
    ['/ui/agents', 'private, no-cache', facts],
    ['/ui/activity', 'private, no-cache', facts],
    ['/ui/landing', 'private, no-cache', facts],
    ['/ui/stuck', 'private, no-cache', facts],
    ['/ui/projects', 'private, no-cache', facts],
    ['/ui/p/compiler/parser', 'private, no-cache', facts],
    ['/ui/p/compiler/parser?status=open', 'private, no-cache', facts],
    [`/ui/i/${report.issueId}`, 'private, no-cache', facts],
    ['/ui/search?q=lease', 'private, no-cache', facts],
    ['/ui/new', 'private, no-cache', facts],
  ]);
});

test('removing prefetch misses 100 ms, and a delay longer than the rest does too', async () => {
  const report = await runGate();
  const home = report.pages[0];
  assert.ok(home);
  const stripped = pageFacts(home.html.replace(/<script type="speculationrules">[\s\S]*?<\/script>/, ''), home.cacheControl);
  assert.deepEqual(judge({ name: 'follow a link', kind: 'link', facts: stripped, serverDelayMs: 0 }), {
    name: 'follow a link', kind: 'link', budgetMs: 100, visibleMs: 150, toleranceMs: 0, pass: false,
  });
  const delayed = await runGate(301);
  assert.equal(gatePasses(delayed), false);
  assert.deepEqual(delayed.verdicts, [
    { name: 'first load', kind: 'first-load', budgetMs: null, visibleMs: null, toleranceMs: 0, pass: true },
    { name: 'follow a link', kind: 'link', budgetMs: 100, visibleMs: 451, toleranceMs: 0, pass: false },
    { name: 'go back', kind: 'history', budgetMs: 16, visibleMs: 16, toleranceMs: 0, pass: true },
    { name: 'go forward', kind: 'history', budgetMs: 16, visibleMs: 16, toleranceMs: 0, pass: true },
    { name: 'submit a search', kind: 'search', budgetMs: null, visibleMs: null, toleranceMs: 0, pass: true },
  ]);
  assert.deepEqual(judge({ name: 'follow a link', kind: 'link', facts: home.facts, serverDelayMs: 150 }), {
    name: 'follow a link', kind: 'link', budgetMs: 100, visibleMs: 80, toleranceMs: 0, pass: true,
  });
});

test('back and forward miss the next frame when the page cannot be restored', async () => {
  const report = await runGate();
  const home = report.pages[0];
  assert.ok(home);
  const stored = pageFacts(home.html, 'private, no-store');
  const blocked = { name: 'go back', kind: 'history' as const, facts: stored, serverDelayMs: 0 };
  assert.deepEqual(judge(blocked), {
    name: 'go back', kind: 'history', budgetMs: 16, visibleMs: 150, toleranceMs: 0, pass: false,
  });
  assert.deepEqual(judge({ ...blocked, name: 'go forward' }), {
    name: 'go forward', kind: 'history', budgetMs: 16, visibleMs: 150, toleranceMs: 0, pass: false,
  });
  const unload = pageFacts(home.html.replace('</body>', '<body onbeforeunload="return true"></body>'), home.cacheControl);
  assert.deepEqual(judge({ name: 'go back', kind: 'history', facts: unload, serverDelayMs: 0 }), {
    name: 'go back', kind: 'history', budgetMs: 16, visibleMs: 150, toleranceMs: 0, pass: false,
  });
});

test('a crossfade longer than 100 ms misses the link budget', () => {
  assert.deepEqual(judge({
    name: 'follow a link', kind: 'link', serverDelayMs: 0,
    facts: { prefetchCoversUi: true, bfcacheEligible: true, viewTransitionMs: 101 },
  }), {
    name: 'follow a link', kind: 'link', budgetMs: 100, visibleMs: 101, toleranceMs: 0, pass: false,
  });
});

test('the CI command exits 0 on the current pages', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = spawnSync(process.execPath, ['scripts/ui-latency-budget.ts'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const printed = JSON.parse(result.stdout) as { toleranceMs: number; verdicts: BudgetVerdict[] };
  assert.equal(printed.toleranceMs, 0);
  assert.deepEqual(printed.verdicts, passing);
});
