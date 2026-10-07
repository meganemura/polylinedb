// Interleaves competing changes before agent write batches on local workerd D1 with the shared race cases.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { d1Executor } from '../src/service/d1.ts';
import { SCHEMA_STATEMENTS } from '../src/records/persistence.ts';
import { runGateRaces } from './fixtures/gate-races.ts';
const modulePath = process.argv[2];
const { Miniflare } = await import(modulePath ? pathToFileURL(modulePath).href : 'miniflare');
const runtime = new Miniflare({ workers: [{ config: { name: 'gate-races-test', compatibilityDate: '2026-09-25', manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response(null); } }' } } }, env: { DB: { type: 'd1', name: 'gate-races-test' } } } }] });
try {
  const database = await runtime.getD1Database('DB'); await database.batch(SCHEMA_STATEMENTS.map(sql => database.prepare(sql)));
  const covered = await runGateRaces(d1Executor(database), 'r');
  assert.equal(covered.length, 10);
  process.stdout.write(`PASS: workerd D1 agent gates hold across ${covered.length} gate-to-write interleavings\n`);
} finally { await runtime.dispose(); }
