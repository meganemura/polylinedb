// Runs the restored-addition owner from a private plan against one D1 database through cf. It needs code review before any use against a real resource.
// The owner keeps every lifecycle decision; this command only validates the plan, checks the cloud connection, and adapts cf output.
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { AdditionRefused, AdditionUnknown, restoredAddition } from './d1-restored-addition.ts';
import type { AdditionOutcome, Batch, ReleaseOutcome } from './d1-restored-addition.ts';
import { readConnections } from '../src/workspace/index.ts';

export type Plan = {
  profile: string; accountId: string; databaseId: string; connection: string; url: string;
  original: string; source: string; journal: string; repositories: string[]; maximumStatements?: number;
};
export type Action = 'run' | 'resume' | 'resume-accepting-destination-edits' | 'release-source';
export const usage = 'Usage: node scripts/d1-restored-addition-command.ts --plan PRIVATE_JSON (--run | --resume [--accept-destination-edits] | --release-source)';

const refuse = (message: string): never => { throw new AdditionRefused(message); };
const actions: Record<string, Action> = {
  '--run': 'run', '--resume': 'resume', '--resume --accept-destination-edits': 'resume-accepting-destination-edits', '--release-source': 'release-source',
};

export function parseArguments(argv: readonly string[]): { plan: string; action: Action } {
  const [flag, plan, ...rest] = argv;
  const action = actions[rest.join(' ')];
  if (flag !== '--plan' || plan === undefined || !isAbsolute(plan) || action === undefined) return refuse(usage);
  return { plan, action };
}

export function readPlan(path: string): Plan {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid())) refuse('The plan must be a private regular file');
  let plan: Record<string, unknown>;
  try { plan = JSON.parse(readFileSync(path, 'utf8')); } catch { return refuse('The plan is not JSON'); }
  const required = ['profile', 'accountId', 'databaseId', 'connection', 'url', 'original', 'source', 'journal', 'repositories'];
  const keys = Object.keys(plan ?? {});
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan) || required.some(key => !keys.includes(key)) || keys.some(key => !required.includes(key) && key !== 'maximumStatements')) refuse('Unexpected plan fields');
  const text = (key: string, pattern: RegExp) => typeof plan[key] === 'string' && pattern.test(plan[key]) ? plan[key] : refuse(`The plan field ${key} is invalid`);
  const absolute = (value: unknown) => typeof value === 'string' && isAbsolute(value);
  if (!['original', 'source', 'journal'].every(key => absolute(plan[key]))) refuse('The plan paths must be absolute');
  if (!Array.isArray(plan.repositories) || !plan.repositories.every(absolute)) refuse('The plan repositories must be absolute paths');
  if (plan.maximumStatements !== undefined && !Number.isSafeInteger(plan.maximumStatements)) refuse('The plan statement limit must be an integer');
  return {
    profile: text('profile', /^[a-zA-Z0-9_-]+$/), accountId: text('accountId', /^[a-f0-9]{32}$/),
    databaseId: text('databaseId', /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
    connection: text('connection', /^[a-z][a-z0-9_-]{0,63}$/), url: text('url', /^https:\/\/[^/?#\s]+$/),
    original: plan.original as string, source: plan.source as string, journal: plan.journal as string, repositories: plan.repositories as string[],
    ...(plan.maximumStatements === undefined ? {} : { maximumStatements: plan.maximumStatements as number }),
  };
}

/** cf prints either the result array or an envelope that holds it. Any failed statement makes the whole response unusable. */
export function d1Results(raw: unknown, count: number): Record<string, unknown>[][] {
  const results = Array.isArray(raw) ? raw : raw !== null && typeof raw === 'object' && 'result' in raw ? raw.result : undefined;
  if (!Array.isArray(results) || results.length !== count) throw new Error('Unexpected D1 batch result');
  return results.map(result => {
    if (result === null || typeof result !== 'object' || result.success !== true || !Array.isArray(result.results)) throw new Error('D1 statement failed');
    return result.results;
  });
}

export async function restoredAdditionCommand(argv: readonly string[], ports: { batch(plan: Plan): Batch; environment: NodeJS.ProcessEnv }): Promise<AdditionOutcome | ReleaseOutcome> {
  const { plan: path, action } = parseArguments(argv);
  const plan = readPlan(path);
  const named = readConnections(ports.environment).connections.find(connection => connection.name === plan.connection)?.definition;
  if (named?.kind !== 'cloud' || named.url !== plan.url) refuse('The plan URL differs from the cloud connection');
  const owner = restoredAddition(ports.batch(plan), plan.journal, ports.environment);
  if (action === 'run') return owner.run({ original: plan.original, source: plan.source, connection: plan.connection, repositories: plan.repositories, ...(plan.maximumStatements === undefined ? {} : { maximumStatements: plan.maximumStatements }) });
  if (action === 'release-source') return owner.releaseSource();
  return owner.resume({ acceptDestinationEdits: action === 'resume-accepting-destination-edits' });
}

// Credentials come only from the cf profile, so inherited Cloudflare and polylinedb overrides are removed.
function cfEnvironment(plan: Plan): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, CLOUDFLARE_ACCOUNT_ID: plan.accountId, CI: '1', NO_COLOR: '1', CF_TELEMETRY_DISABLED: '1' };
  for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CF_API_TOKEN', 'CF_API_KEY', 'CF_EMAIL', 'POLYLINEDB_CONNECTION', 'POLYLINEDB_DATA_DIR', 'POLYLINEDB_ACTOR']) delete environment[key];
  return environment;
}

function cfBatch(plan: Plan): Batch {
  return async statements => {
    const directory = mkdtempSync(join(tmpdir(), 'pd-restored-addition-batch-'));
    try {
      const file = join(directory, 'batch.json');
      writeFileSync(file, JSON.stringify(statements), { mode: 0o600, flag: 'wx' });
      const result = spawnSync('cf', ['d1', 'query', plan.databaseId, '--batch', `@${file}`, '--profile', plan.profile], { cwd: directory, env: cfEnvironment(plan), encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
      if (result.status !== 0 || result.error) throw new Error('cf d1 query failed');
      return d1Results(JSON.parse(result.stdout), statements.length);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  };
}

if (import.meta.main) {
  try {
    process.stdout.write(`${JSON.stringify(await restoredAdditionCommand(process.argv.slice(2), { batch: cfBatch, environment: process.env }))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error'}\n`);
    process.exitCode = error instanceof AdditionRefused ? 2 : error instanceof AdditionUnknown ? 3 : 1;
  }
}
