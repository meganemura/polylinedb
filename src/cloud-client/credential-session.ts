/** Serializes a resource's secure credential replacement. Lock files never contain credentials. */
import { createHash } from 'node:crypto';
import { mkdir, lstat, realpath, rmdir, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

/** Adapters must use an OS credential store and distinguish missing entries from access failures. */
export interface CredentialStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** A diagnostic carries only a file system error code, never a path. */
export type OAuthErrorDetails = { readonly diagnostic: { readonly code: string } };

export class OAuthError extends Error {
  readonly code: string;
  readonly details: OAuthErrorDetails | undefined;
  constructor(code: string, message: string, details?: OAuthErrorDetails) { super(message); this.name = 'OAuthError'; this.code = code; this.details = details; }
}

export function credentialKey(resource: string, namespace: string): string {
  return `oauth-${createHash('sha256').update(JSON.stringify([namespace, resource])).digest('hex')}`;
}

const authBusyWait = 'Wait and retry. Do not delete the lock directory while another pd process may still be running. Remove the lock directory only after you verify that no pd process is running for this configuration.';

function authBusyMessage(login: boolean): string {
  const holder = login
    ? 'The lock contents show that the holder is an interactive pd auth login, which can wait up to 300 seconds for the browser callback.'
    : 'Another pd process may still hold the authentication lock while it works, for example during a token refresh or an interactive pd auth login, which can wait up to 300 seconds for the browser callback.';
  return `Authentication is busy. ${holder} ${authBusyWait}`;
}

async function lockShowsLogin(lock: string): Promise<boolean> {
  try { return (await readdir(lock)).includes('login'); }
  catch { return false; }
}

function fileSystemCode(error: unknown): string | undefined {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^E[A-Z0-9]{1,31}$/.test(code) ? code : undefined;
}

function lockCreationError(code: string | undefined): OAuthError {
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new OAuthError('auth_state_access_denied', 'Authentication state is not writable. Allow access to the authentication state directory and retry.', { diagnostic: { code } });
  }
  const notContention = 'This is not contention with another pd process, so waiting does not help.';
  if (code === undefined) return new OAuthError('auth_lock_failed', `Could not acquire the authentication lock. ${notContention}`);
  return new OAuthError('auth_lock_failed', `Could not acquire the authentication lock: the file system returned ${code} for the authentication state directory. ${notContention} Resolve the file system error and retry.`, { diagnostic: { code } });
}

export async function credentialTransaction<T>(options: {
  stateDirectory: string; resource: string; lockTimeoutMs: number;
}, action: (key: string) => Promise<T>): Promise<T> {
  if (!isAbsolute(options.stateDirectory)) throw new OAuthError('auth_state_invalid', 'The authentication state directory must be absolute.');
  try { await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 }); }
  catch (error) { throw lockCreationError(fileSystemCode(error)); }
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
      const code = fileSystemCode(error);
      if (code !== 'EEXIST') throw lockCreationError(code);
      if (Date.now() >= deadline) throw new OAuthError('auth_busy', authBusyMessage(await lockShowsLogin(lock)));
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
