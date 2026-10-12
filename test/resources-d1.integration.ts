// Runs the shared resource flow through local workerd D1 and the shared domain executor.
import { pathToFileURL } from 'node:url';
import { d1Executor } from '../src/service/d1.ts';
import { executeOperation, parseOperation } from '../src/records/index.ts';
import { SCHEMA_STATEMENTS } from '../src/records/persistence.ts';
import { runResourceFlow } from './fixtures/resource-flow.ts';
const modulePath = process.argv[2];
const { Miniflare } = await import(modulePath ? pathToFileURL(modulePath).href : 'miniflare');
const runtime = new Miniflare({ workers: [{ config: { name: 'resource-test', compatibilityDate: '2026-09-25', manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response("ready"); } }' } } }, env: { DB: { type: 'd1', name: 'resource-test' } } } }] });
try {
  const database = await runtime.getD1Database('DB'); await database.batch(SCHEMA_STATEMENTS.map(sql => database.prepare(sql)));
  const db = d1Executor(database);
  await runResourceFlow(async (value, caller = 'test:d1') => executeOperation(db, parseOperation(value), caller), 'test:d1');
  process.stdout.write('PASS: workerd D1 resource receipts, replays, conflicts, forward-only marks, close guard, live listing, feed and agent gate\n');
} finally { await runtime.dispose(); }
