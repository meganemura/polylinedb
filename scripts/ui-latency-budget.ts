// CI bound for the /ui latency budget. See docs/ui-latency.md. Paint samples stay in scripts/ui-latency.ts.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { storageOf } from 'solarsql/node';
import { SCHEMA_SQL } from '../src/records/persistence.ts';
import { handleRequest, type Environment } from '../src/service/index.ts';

export const linkBudgetMs = 100;
export const frameMs = 16;
export const phoneStandInMs = 150;
export const restMs = 300;
export const toleranceMs = 0;

export type StepKind = 'first-load' | 'link' | 'history' | 'search';

export type PageFacts = {
  prefetchCoversUi: boolean;
  bfcacheEligible: boolean;
  viewTransitionMs: number;
};

export type BudgetStep = {
  name: string;
  kind: StepKind;
  facts: PageFacts;
  serverDelayMs: number;
};

export type BudgetVerdict = {
  name: string;
  kind: StepKind;
  budgetMs: number | null;
  visibleMs: number | null;
  toleranceMs: number;
  pass: boolean;
};

export type LoadedPage = {
  path: string;
  cacheControl: string;
  html: string;
  facts: PageFacts;
};

export type GateReport = {
  issueId: string;
  pages: LoadedPage[];
  verdicts: BudgetVerdict[];
};

export function pageFacts(html: string, cacheControl: string): PageFacts {
  let prefetchCoversUi = false;
  const rulesText = html.match(/<script type="speculationrules">([\s\S]*?)<\/script>/)?.[1];
  if (rulesText !== undefined) {
    try {
      const rules = JSON.parse(rulesText) as { prefetch?: { where?: { or?: { href_matches?: string }[] } }[] };
      const matches = (rules.prefetch ?? []).flatMap(rule => (rule.where?.or ?? []).map(item => item.href_matches));
      prefetchCoversUi = matches.includes('/ui') && matches.includes('/ui/*');
    } catch {
      prefetchCoversUi = false;
    }
  }
  const durations = html.includes('@view-transition')
    ? [...html.matchAll(/animation-duration:\s*(\d+(?:\.\d+)?)\s*ms/g)].map(match => Number(match[1]))
    : [];
  const viewTransitionMs = durations.length === 0 ? 0 : Math.max(...durations);
  return { prefetchCoversUi, bfcacheEligible: bfcacheEligible(html, cacheControl), viewTransitionMs };
}

function bfcacheEligible(html: string, cacheControl: string): boolean {
  if (/\bno-store\b/.test(cacheControl)) return false;
  if (/\bon(?:before)?unload\s*=|\bonpagehide\s*=/i.test(html)) return false;
  const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
  return scripts.every(match => {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    if (attrs.includes('type="speculationrules"')) return true;
    return !body.includes('beforeunload') && !body.includes('pagehide');
  });
}

export function budgetMs(kind: StepKind): number | null {
  if (kind === 'link') return linkBudgetMs;
  if (kind === 'history') return frameMs;
  return null;
}

export function visibleBoundMs(step: BudgetStep): number | null {
  if (budgetMs(step.kind) === null) return null;
  if (step.kind === 'history') return step.facts.bfcacheEligible ? frameMs : phoneStandInMs + step.serverDelayMs;
  const held = step.facts.prefetchCoversUi && step.serverDelayMs <= restMs;
  return held ? step.facts.viewTransitionMs : phoneStandInMs + step.serverDelayMs;
}

export function judge(step: BudgetStep): BudgetVerdict {
  const budget = budgetMs(step.kind);
  const visibleMs = visibleBoundMs(step);
  const pass = budget === null || (visibleMs !== null && visibleMs <= budget + toleranceMs);
  return { name: step.name, kind: step.kind, budgetMs: budget, visibleMs, toleranceMs, pass };
}

export function budgetSteps(facts: PageFacts, serverDelayMs = 0): BudgetStep[] {
  return [
    { name: 'first load', kind: 'first-load', facts, serverDelayMs },
    { name: 'follow a link', kind: 'link', facts, serverDelayMs },
    { name: 'go back', kind: 'history', facts, serverDelayMs },
    { name: 'go forward', kind: 'history', facts, serverDelayMs },
    { name: 'submit a search', kind: 'search', facts, serverDelayMs },
  ];
}

export function gatePasses(report: GateReport): boolean {
  const first = report.pages[0];
  if (first === undefined) return false;
  const sameFacts = report.pages.every(page => page.facts.prefetchCoversUi === first.facts.prefetchCoversUi
    && page.facts.bfcacheEligible === first.facts.bfcacheEligible
    && page.facts.viewTransitionMs === first.facts.viewTransitionMs
    && page.cacheControl === first.cacheControl);
  return sameFacts && report.verdicts.every(row => row.pass);
}

export async function runGate(serverDelayMs = 0): Promise<GateReport> {
  const sqlite = new DatabaseSync(':memory:');
  try {
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
    const env: Environment = {
      DB: {
        prepare,
        async batch(statements: ReturnType<typeof prepare>[]) {
          sqlite.exec('BEGIN IMMEDIATE');
          try {
            const results = statements.map(({ sql, params }) => ({ success: true, results: storage.sql.exec(sql, ...params).toArray() }));
            sqlite.exec('COMMIT');
            return results;
          } catch (error) {
            sqlite.exec('ROLLBACK');
            throw error;
          }
        },
      },
      ACCESS_TEAM_DOMAIN: 'polylinedb-budget.cloudflareaccess.com',
      ACCESS_AUD: 'polylinedb-budget',
      ACCESS_ACTORS: '["access:owner"]',
      ALLOWED_ORIGINS: '[]',
    };
    const authenticate = async () => ({ actor: { id: 'access:owner', kind: 'human' as const }, access: 'write' as const });
    const request = (path: string, method: string, body?: string) => handleRequest(new Request(`https://issues.example${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    }), env, authenticate);
    const created = await request('/v1/operations', 'POST', JSON.stringify({
      op: 'create', prefix: 'pd', request_id: crypto.randomUUID(), tool: 'compiler', project: 'parser', body: 'Latency budget issue',
    }));
    const createdText = await created.text();
    assert.equal(created.status, 200, createdText);
    const issueId = (JSON.parse(createdText) as { issue: { id: string } }).issue.id;
    const project = '/ui/p/compiler/parser';
    const paths = ['/ui', project, `${project}?status=open`, `/ui/i/${issueId}`, '/ui/inbox', '/ui/working', '/ui/blocked', '/ui/recent', '/ui/search?q=lease'];
    const pages: LoadedPage[] = [];
    for (const path of paths) {
      const response = await request(path, 'GET');
      const html = await response.text();
      assert.equal(response.status, 200, `${path}: ${html.slice(0, 200)}`);
      const cacheControl = response.headers.get('cache-control') ?? '';
      pages.push({ path, cacheControl, html, facts: pageFacts(html, cacheControl) });
    }
    const home = pages[0];
    assert.ok(home);
    return { issueId, pages, verdicts: budgetSteps(home.facts, serverDelayMs).map(judge) };
  } finally {
    sqlite.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runGate();
  const printed = {
    toleranceMs,
    pages: report.pages.map(page => ({ path: page.path, cacheControl: page.cacheControl, facts: page.facts })),
    verdicts: report.verdicts,
  };
  process.stdout.write(`${JSON.stringify(printed, null, 2)}\n`);
  if (!gatePasses(report)) process.exitCode = 1;
}
