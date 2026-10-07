// Proves that the transition and local workerd D1 accept the same commands with the shared differential cases.
import { pathToFileURL } from 'node:url';
import { d1Executor } from '../src/service/d1.ts';
import { SCHEMA_STATEMENTS } from '../src/records/persistence.ts';
import { runDifferential } from './fixtures/transition-differential.ts';
const modulePath = process.argv[2];
const { Miniflare } = await import(modulePath ? pathToFileURL(modulePath).href : 'miniflare');
const runtime = new Miniflare({ workers: [{ config: { name: 'differential-test', compatibilityDate: '2026-09-25', manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response(null); } }' } } }, env: { DB: { type: 'd1', name: 'differential-test' } } } }] });
const seed = Number(process.env.PD_DIFFERENTIAL_SEED ?? 20261007);
try {
  const database = await runtime.getD1Database('DB'); await database.batch(SCHEMA_STATEMENTS.map(sql => database.prepare(sql)));
  await runDifferential(d1Executor(database), 'q', Number(process.env.PD_HEGEL_CASES ?? 100), seed);
  process.stdout.write(`PASS: transition decisions match workerd D1 conditional writes (seed ${seed})\n`);
} finally { await runtime.dispose(); }
