// Runs an operator-only D1 transfer through cf; authentication remains in the selected cf profile.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { snapshotMigration, type Query } from './d1-snapshot-store.ts';

export function parseTarget(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid target');
  if (!('profile' in value) || typeof value.profile !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value.profile)
    || !('accountId' in value) || typeof value.accountId !== 'string' || !/^[a-f0-9]{32}$/.test(value.accountId)
    || !('databaseId' in value) || typeof value.databaseId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.databaseId)
    || !('snapshotSha256' in value) || typeof value.snapshotSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.snapshotSha256)
    || !('schemaVersion' in value) || value.schemaVersion !== 2
    || Object.keys(value).sort().join(',') !== 'accountId,databaseId,profile,schemaVersion,snapshotSha256') throw new Error('Invalid fixed target fields');
  return Object.freeze({ profile: value.profile, accountId: value.accountId, databaseId: value.databaseId, snapshotSha256: value.snapshotSha256, schemaVersion: value.schemaVersion });
}

export function parseQueryOutput(value: unknown): Record<string, unknown>[] {
  // cf preserves API envelopes, but unwraps result arrays when result_info is present.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (!('success' in value) || value.success !== true || !('result' in value)) throw new Error('cf query envelope failed');
    value = value.result;
  }
  if (!Array.isArray(value) || value.length !== 1) throw new Error('Unexpected cf query result count');
  const result: unknown = value[0];
  if (!result || typeof result !== 'object' || !('success' in result) || result.success !== true
    || !('results' in result) || !Array.isArray(result.results)) throw new Error('cf query did not return successful rows');
  return result.results.map((row: unknown) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid cf query row');
    return Object.fromEntries(Object.entries(row));
  });
}

export function cfQuery(target: ReturnType<typeof parseTarget>): Query {
  return async statement => {
    if (Buffer.byteLength(statement.sql) > 100_000 || statement.params.length > 100) throw new Error('D1 statement limit exceeded');
    const directory = mkdtempSync(join(tmpdir(), 'pd-d1-query-'));
    try {
      const file = join(directory, 'query.json');
      writeFileSync(file, JSON.stringify([statement]), { mode: 0o600, flag: 'wx' });
      const env: NodeJS.ProcessEnv = { ...process.env, CLOUDFLARE_ACCOUNT_ID: target.accountId, NO_COLOR: '1', CI: '1', CF_TELEMETRY_DISABLED: '1' };
      // Ambient token variables must not replace the explicitly selected profile.
      for (const name of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CF_API_TOKEN', 'CF_API_KEY', 'CF_EMAIL']) delete env[name];
      const result = spawnSync('cf', ['d1', 'query', target.databaseId, '--profile', target.profile, '--batch', `@${file}`], {
        cwd: directory, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
      });
      // cf diagnostics can include SQL or credentials. Report status without echoing either stream.
      if (result.error || result.status !== 0) throw new Error('cf query failed; the destination may contain a resumable partial import');
      let parsed: unknown;
      try { parsed = JSON.parse(result.stdout); } catch { throw new Error('cf query returned invalid JSON'); }
      return parseQueryOutput(parsed);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  };
}

async function main(args: string[]) {
  const [action, ...flags] = args;
  if (!['inspect', 'restore', 'verify'].includes(action ?? '') || flags.length !== 4 || flags[0] !== '--snapshot' || flags[2] !== '--target' || !flags[1] || !flags[3]) {
    throw new Error('Usage: node scripts/d1-snapshot.ts inspect|restore|verify --snapshot FILE --target FILE');
  }
  const target = parseTarget(JSON.parse(readFileSync(flags[3], 'utf8')));
  const snapshot: unknown = JSON.parse(readFileSync(flags[1], 'utf8'));
  const migration = snapshotMigration(cfQuery(target), snapshot, target.snapshotSha256);
  const report = action === 'restore' ? await migration.restore() : action === 'verify' ? await migration.verify() : await migration.inspect();
  // Snapshot content remains private. The receipt includes only identity, counts, and digest.
  const { snapshot: _snapshot, ...receipt } = 'snapshot' in report ? report : { ...report, snapshot: undefined };
  process.stdout.write(JSON.stringify({ target, ...receipt }) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    const reason = error instanceof Error && !(error instanceof SyntaxError) && !('code' in error)
      ? error.message : 'Check the input files and snapshot format';
    process.stderr.write(`D1 snapshot operation failed: ${reason}.\n`);
    process.exitCode = 1;
  });
}
