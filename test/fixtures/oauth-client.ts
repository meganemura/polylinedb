/** Test-only plaintext store lets independent processes exercise the real credential lock.
 * `share` records that this process saw the lock, and the holder finishes the refresh only after that record exists.
 * Pass a lock timeout argument when a case must return `auth_busy` without waiting the production budget.
 */
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const directory = process.argv[2];
const mode = process.argv[3];
const lockTimeoutMs = process.argv[4] === undefined ? 10_000 : Number(process.argv[4]);
if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0) {
  process.stderr.write('invalid lock timeout\n');
  process.exit(1);
}

const waiting = join(directory, 'waiting');
if (mode === 'share') {
  const fsPromises = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
  const originalMkdir = fsPromises.mkdir;
  fsPromises.mkdir = (async (path: string, options?: { recursive?: boolean; mode?: number }) => {
    try {
      return await originalMkdir(path, options);
    } catch (error) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
      if (code === 'EEXIST' && path.endsWith('.lock')) {
        const temporary = `${waiting}.${process.pid}`;
        await writeFile(temporary, 'waiting\n');
        await rename(temporary, waiting);
      }
      throw error;
    }
  }) as typeof fsPromises.mkdir;
  syncBuiltinESMExports();
}

const { createCloudAuth, OAuthError } = await import('../../src/cloud-client/oauth.ts');
const file = join(directory, 'test-store.json');
const auth = createCloudAuth({
  origin: 'https://issues.example', stateDirectory: join(directory, 'locks'), lockTimeoutMs, requestTimeoutMs: 30_000,
  credentialStore: {
    async read(key) { const entries = JSON.parse(await readFile(file, 'utf8')); return entries[key] ?? null; },
    async write(key, value) { const entries = JSON.parse(await readFile(file, 'utf8')); entries[key] = value; const temporary = `${file}.${process.pid}`; await writeFile(temporary, JSON.stringify(entries)); await rename(temporary, file); },
    async delete() { throw new Error('unused'); },
  },
  fetch: async () => {
    await appendFile(join(directory, 'refreshes'), 'refresh\n');
    if (mode === 'crash') process.exit(42);
    if (mode === 'share') {
      const deadline = Date.now() + 20_000;
      for (;;) {
        try {
          if (await readFile(waiting, 'utf8') === 'waiting\n') break;
        } catch (error) {
          const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
          if (code !== 'ENOENT') throw error;
        }
        if (Date.now() >= deadline) break;
        await delay(5);
      }
      // Remain in the lock after the waiter arrives, longer than the 150ms abandoned-lock budget.
      await delay(200);
    }
    return Response.json({ token_type: 'Bearer', access_token: 'child-access', refresh_token: 'child-refresh', expires_in: 3600 });
  },
});
try { process.stdout.write(await auth.accessToken()); }
catch (error) { process.stdout.write(error instanceof OAuthError ? error.code : 'unexpected'); process.exitCode = 1; }
