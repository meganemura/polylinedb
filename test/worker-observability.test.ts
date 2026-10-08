// Builds the Worker the way `cf build` does and reads the generated configuration that a deploy uploads.
// The build runs in a scratch root, so `cf deploy --prebuilt` can never pick up its placeholder Access values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));

test('the built Worker keeps logs on and invocation logs off', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'polylinedb-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['src', 'cloudflare.config.ts', 'vite.config.ts', 'package.json', 'tsconfig.json', 'node_modules']) {
    symlinkSync(join(repository, entry), join(root, entry));
  }
  const build = spawnSync('npm', ['exec', '--', 'vite', 'build'], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, CLOUDFLARE_VITE_FORCE_BUILD_OUTPUT: 'true',
      POLYLINEDB_ACCESS_TEAM_DOMAIN: 'build-test.cloudflareaccess.com', POLYLINEDB_ACCESS_AUD: 'build-test-audience',
      POLYLINEDB_ACCESS_ACTORS: '["access:build-test"]', POLYLINEDB_ALLOWED_ORIGINS: '[]' },
  });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const config = JSON.parse(readFileSync(join(root, '.cloudflare/output/v0/workers/default/worker.config.json'), 'utf8'));
  assert.deepEqual(config.observability, { enabled: true, logs: { enabled: true, invocationLogs: false } },
    'invocation logs record every request and may keep the Cf-Access-Jwt-Assertion header; only console lines may reach Workers Logs');
});
