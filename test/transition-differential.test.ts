// Proves that the transition and the SQLite conditional writes accept the same commands; the D1 run uses the same cases.
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeStore, openStore } from '../src/local-store/index.ts';
import { runDifferential } from './fixtures/transition-differential.ts';

const cases = Number(process.env.PD_HEGEL_CASES ?? 100);
const seed = Number(process.env.PD_DIFFERENTIAL_SEED ?? 20261007);

test('property: the transition and SQLite agree on every generated command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pd-differential-'));
  const cwd = join(root, 'work'); const directory = join(root, 'store'); mkdirSync(cwd);
  try {
    initializeStore({ directory, cwd });
    const store = openStore({ directory, cwd });
    try { await runDifferential(store.db, 'q', cases, seed); }
    catch (error) { throw new Error(`Differential seed ${seed} failed`, { cause: error }); }
    finally { store.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
