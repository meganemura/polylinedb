// Decides whether the publish job runs `npm publish` for the verified tarball.
// A re-run may find the version already on npm. It skips publication only when the registry integrity equals the tarball's,
// because npm never accepts the same version twice and a different tarball under that version must not be called released.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const versionPattern = /^\d+\.\d+\.\d+$/;

export function tarballIntegrity(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

// `npm view polylinedb@X.Y.Z dist.integrity --json` prints nothing for a version the package does not have,
// and exits with E404 when the package itself does not exist.
export function publishDecision(view: { status: number | null; stdout: string; stderr: string }, expected: string): 'publish' | 'skip' {
  if (view.status !== 0) {
    if (/\bE404\b/.test(view.stderr)) return 'publish';
    throw new Error(`npm view failed with status ${String(view.status)}: ${view.stderr.trim().split('\n')[0] ?? ''}`);
  }
  if (view.stdout.trim() === '') return 'publish';
  let published: unknown;
  try {
    published = JSON.parse(view.stdout);
  } catch {
    throw new Error('npm view returned unexpected output');
  }
  if (published !== expected) throw new Error(`The registry already has this version with integrity ${String(published)}, not ${expected}`);
  return 'skip';
}

if (import.meta.main) {
  try {
    const version = process.env.RELEASE_VERSION ?? '';
    const tarball = process.env.RELEASE_TARBALL ?? '';
    if (!versionPattern.test(version)) throw new Error('RELEASE_VERSION must be X.Y.Z');
    if (tarball === '') throw new Error('RELEASE_TARBALL is missing');
    const view = spawnSync('npm', ['view', `polylinedb@${version}`, 'dist.integrity', '--json', '--prefer-online', '--registry=https://registry.npmjs.org/'], { encoding: 'utf8' });
    if (view.error) throw view.error;
    const decision = publishDecision({ status: view.status, stdout: view.stdout, stderr: view.stderr }, tarballIntegrity(readFileSync(tarball)));
    process.stderr.write(decision === 'publish' ? `polylinedb@${version} is not on npm yet.\n` : `polylinedb@${version} is already on npm with the same integrity, so npm publish is skipped.\n`);
    process.stdout.write(`${decision}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Unknown error'}\n`);
    process.exitCode = 1;
  }
}
