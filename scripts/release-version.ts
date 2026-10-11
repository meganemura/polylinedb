// Decides whether a push to main releases a new version.
// The version comes from package.json, and both lockfile versions must match it.
// An existing v<version> tag means that version was already released, or the push reverted a bump, so nothing is released.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { releaseTag } from './github-release.ts';

const versionPattern = /^\d+\.\d+\.\d+$/;

export function manifestVersion(manifest: unknown, lock: unknown): string {
  const version = manifest !== null && typeof manifest === 'object' && 'version' in manifest ? manifest.version : undefined;
  if (typeof version !== 'string' || !versionPattern.test(version)) throw new Error(`package.json version must be X.Y.Z, not ${String(version)}`);
  const record = lock !== null && typeof lock === 'object' ? lock as { version?: unknown; packages?: { ''?: { version?: unknown } } } : {};
  if (record.version !== version) throw new Error(`package-lock.json version ${String(record.version)} does not match package.json ${version}`);
  if (record.packages?.['']?.version !== version) throw new Error(`package-lock.json packages[""].version ${String(record.packages?.['']?.version)} does not match package.json ${version}`);
  return version;
}

// `git ls-remote --exit-code` exits 2 when no ref matches and 0 when one does; any other status is a failure.
export function tagDecision(status: number | null, tag: string): 'release' | 'skip' {
  if (status === 2) return 'release';
  if (status === 0) return 'skip';
  throw new Error(`git ls-remote failed for ${tag} with status ${String(status)}`);
}

export function releaseOutputs(version: string, decision: 'release' | 'skip'): string {
  return decision === 'release' ? `tag=${releaseTag(version)}\nversion=${version}\n` : 'tag=\nversion=\n';
}

if (import.meta.main) {
  try {
    const version = manifestVersion(JSON.parse(readFileSync('package.json', 'utf8')), JSON.parse(readFileSync('package-lock.json', 'utf8')));
    const tag = releaseTag(version);
    const lookup = spawnSync('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`], { encoding: 'utf8' });
    if (lookup.error) throw lookup.error;
    const decision = tagDecision(lookup.status, tag);
    process.stdout.write(decision === 'release' ? `Releasing ${version}; ${tag} does not exist yet.\n` : `${tag} already exists, so nothing is released.\n`);
    const output = process.env.GITHUB_OUTPUT;
    if (output) appendFileSync(output, releaseOutputs(version, decision));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Unknown error'}\n`);
    process.exitCode = 1;
  }
}
