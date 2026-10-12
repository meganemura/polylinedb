// Keeps the parallel D1 runner complete and its failures visible.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { d1Files, runAll } from '../scripts/test-d1.ts';

test('the D1 runner lists every local workerd integration file except the Worker bundle test', () => {
  const files = readdirSync(new URL('.', import.meta.url)).filter(name => name.endsWith('.integration.ts') && name !== 'worker.integration.ts');
  assert.deepEqual([...d1Files].sort(), files.map(name => `test/${name}`).sort());
});

test('the runner keeps list order and reports a failing file', async () => {
  const outcomes = await runAll(['scripts/no-such-file.ts', 'scripts/test-d1.test-missing.ts'], 2);
  assert.deepEqual(outcomes.map(outcome => outcome.file), ['scripts/no-such-file.ts', 'scripts/test-d1.test-missing.ts']);
  assert.deepEqual(outcomes.map(outcome => outcome.status), [1, 1]);
  assert.match(outcomes[0]!.output, /Cannot find module/);
});
