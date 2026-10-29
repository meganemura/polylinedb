// Runs the asks and checks flows on local workerd D1; test/items.test.ts runs them on local SQLite.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { d1Executor } from '../src/service/d1.ts';
import { SCHEMA_STATEMENTS, schemaUpgradeStatements } from '../src/records/persistence/persistence.ts';
import { SCHEMA_V11_STATEMENTS } from '../src/records/persistence/schema-v11.ts';
import { checkSchema11Upgrade, populateSchema11, runItemsFlow } from './fixtures/items-flow.ts';

const modulePath = process.argv[2];
const { Miniflare } = await import(modulePath ? pathToFileURL(modulePath).href : 'miniflare');
const binding = (name: string) => ({ type: 'd1', name });
const runtime = new Miniflare({ workers: [{ config: { name: 'items-test', compatibilityDate: '2026-09-25',
  manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response(null); } }' } } },
  env: { DB: binding('items'), POPULATED: binding('items-v11-populated') } } }] });
try {
  const schema = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name";
  const database = await runtime.getD1Database('DB'); await database.batch(SCHEMA_STATEMENTS.map(sql => database.prepare(sql)));
  await runItemsFlow(d1Executor(database));

  const populated = await runtime.getD1Database('POPULATED'); await populated.batch(SCHEMA_V11_STATEMENTS.map(sql => populated.prepare(sql)));
  const written = await populateSchema11(d1Executor(populated));
  const before = (await populated.prepare('SELECT * FROM change_events ORDER BY seq').all()).results.map((row: Record<string, unknown>) => ({ ...row }));
  await populated.batch(schemaUpgradeStatements(11).map(sql => populated.prepare(sql)));
  assert.deepEqual((await populated.prepare(schema).all()).results, (await database.prepare(schema).all()).results);
  await checkSchema11Upgrade(d1Executor(populated), written, before);
  process.stdout.write('PASS: workerd D1 asks take an issue off ready and onto owner waits, answers come only from a person who did not ask and land once under a race, checks hold close and handoff until met, force closes past them, the feed records asked, answered, and became_ready in order, and the schema 11 to 12 upgrade keeps every event at its seq\n');
} finally { await runtime.dispose(); }
