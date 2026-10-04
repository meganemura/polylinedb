/** Test-only plaintext store lets independent processes exercise the real credential lock. */
import { readFile, writeFile, rename, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCloudAuth, OAuthError } from '../../src/cloud-client/oauth.ts';
const directory = process.argv[2];
const mode = process.argv[3];
const file = join(directory, 'test-store.json');
const auth = createCloudAuth({
  origin: 'https://issues.example', stateDirectory: join(directory, 'locks'), lockTimeoutMs: 150,
  credentialStore: {
    async read(key) { const entries = JSON.parse(await readFile(file, 'utf8')); return entries[key] ?? null; },
    async write(key, value) { const entries = JSON.parse(await readFile(file, 'utf8')); entries[key] = value; const temporary = `${file}.${process.pid}`; await writeFile(temporary, JSON.stringify(entries)); await rename(temporary, file); },
    async delete() { throw new Error('unused'); },
  },
  fetch: async () => {
    await appendFile(join(directory, 'refreshes'), 'refresh\n');
    if (mode === 'crash') process.exit(42);
    await new Promise(resolve => setTimeout(resolve, 60));
    return Response.json({ token_type: 'Bearer', access_token: 'child-access', refresh_token: 'child-refresh', expires_in: 3600 });
  },
});
try { process.stdout.write(await auth.accessToken()); }
catch (error) { process.stdout.write(error instanceof OAuthError ? error.code : 'unexpected'); process.exitCode = 1; }
