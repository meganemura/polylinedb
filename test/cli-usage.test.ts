// Pins the help text, which every `pd COMMAND --help` prints, as a public contract.
// cli.test.ts pins the claim command entries in cli-claim-usage.txt, so this snapshot omits them.
// An intentional usage change updates test/snapshots/cli-usage.txt in the same commit:
// UPDATE_SNAPSHOTS=1 node --test test/cli-usage.test.ts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { assertSnapshot } from './fixtures/snapshot.ts';

const executable = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const claimEntries = /^  claim .*\n(?: {8,}\S.*\n)*/gm;

test('help pins the usage of the non-claim commands', (t: TestContext) => {
  const cwd = mkdtempSync(join(tmpdir(), 'polylinedb-usage-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(cwd, 'config-home') };
  for (const name of ['POLYLINEDB_ACTOR', 'POLYLINEDB_ACTOR_KIND', 'POLYLINEDB_DATA_DIR', 'POLYLINEDB_CONNECTION', 'POLYLINEDB_SESSION_ID']) delete env[name];
  const result = spawnSync(process.execPath, [executable, '--help'], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const usage = result.stdout.replace(claimEntries, '');
  assert.notEqual(usage, result.stdout, 'help lists the claim commands that cli-claim-usage.txt pins');
  assertSnapshot('cli-usage.txt', usage);
});
