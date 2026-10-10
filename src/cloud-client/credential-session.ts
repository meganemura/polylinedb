/** Serializes a resource's secure credential replacement. Lock files never contain credentials. */
import { createHash } from 'node:crypto';
import { mkdir, lstat, realpath, rmdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

/** Adapters must use an OS credential store and distinguish missing entries from access failures. */
export interface CredentialStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'OAuthError'; this.code = code; }
}

export function credentialKey(resource: string, namespace: string): string {
  return `oauth-${createHash('sha256').update(JSON.stringify([namespace, resource])).digest('hex')}`;
}

export async function credentialTransaction<T>(options: {
  stateDirectory: string; resource: string; lockTimeoutMs: number;
}, action: (key: string) => Promise<T>): Promise<T> {
  if (!isAbsolute(options.stateDirectory)) throw new OAuthError('auth_state_invalid', 'The authentication state directory must be absolute.');
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  const directory = await lstat(options.stateDirectory);
  if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || (process.getuid && directory.uid !== process.getuid())) {
    throw new OAuthError('auth_state_invalid', 'The authentication state directory must be private and owned by the current user.');
  }
  const namespace = await realpath(options.stateDirectory);
  const key = credentialKey(options.resource, namespace);
  const lock = join(namespace, `${key}.lock`);
  const deadline = Date.now() + options.lockTimeoutMs;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'EACCES' || code === 'EPERM') {
        throw new OAuthError('auth_state_access_denied', 'Authentication state is not writable. Allow access to the authentication state directory and retry.');
      }
      if (code !== 'EEXIST') throw new OAuthError('auth_lock_failed', 'Could not acquire the authentication lock.');
      if (Date.now() >= deadline) throw new OAuthError('auth_busy', 'Authentication is busy. If a prior process stopped, remove its lock directory after verifying that no authentication process is running.');
      await setTimeout(25);
    }
  }
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try { outcome = { ok: true, value: await action(key) }; }
  catch (error) { outcome = { ok: false, error }; }
  try { await rmdir(lock); }
  catch (error) {
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    if (code !== 'ENOENT') process.stderr.write('auth_lock_release_failed: The authentication lock could not be removed. Later commands can return auth_busy until that lock directory is removed.\n');
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
