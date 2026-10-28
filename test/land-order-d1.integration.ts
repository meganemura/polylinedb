// Runs the shared land-order flow through local workerd D1 and the shared domain executor.
import { pathToFileURL } from 'node:url';
import { d1Executor } from '../src/service/d1.ts';
import { executeOperation, parseOperation } from '../src/records/index.ts';
import { SCHEMA_STATEMENTS } from '../src/records/persistence/persistence.ts';
import { runLandOrderFlow } from './fixtures/land-order-flow.ts';
const modulePath = process.argv[2];
const { Miniflare } = await import(modulePath ? pathToFileURL(modulePath).href : 'miniflare');
const runtime = new Miniflare({ workers: [{ config: { name: 'land-order-test', compatibilityDate: '2026-09-25', manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response("ready"); } }' } } }, env: { DB: { type: 'd1', name: 'land-order-test' } } } }] });
try {
  const database = await runtime.getD1Database('DB'); await database.batch(SCHEMA_STATEMENTS.map(sql => database.prepare(sql)));
  const db = d1Executor(database);
  await runLandOrderFlow((value, caller = 'test:d1') => executeOperation(db, parseOperation(value), caller), 'test:d1');
  process.stdout.write('PASS: workerd D1 land order receipts, replays, conflicts, cycles across both edge kinds, feed relation, handoff warnings and agent gate\n');
} finally { await runtime.dispose(); }
