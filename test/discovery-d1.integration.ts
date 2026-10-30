// Runs discovery links on local workerd D1; test/discovery.test.ts runs the same flows on local SQLite.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { d1Executor } from '../src/service/d1.ts';
import { SCHEMA_STATEMENTS, schemaUpgradeStatements } from '../src/records/persistence/persistence.ts';
import { SCHEMA_V12_STATEMENTS } from '../src/records/persistence/schema-v12.ts';
import { checkSchema12Discovery, populateSchema12Discovery, runDiscoveryFlow } from './fixtures/discovery-flow.ts';

const modulePath = process.argv[2];
const { Miniflare } = await import(modulePath ? pathToFileURL(modulePath).href : 'miniflare');
const binding = (name: string) => ({ type: 'd1', name });
const runtime = new Miniflare({ workers: [{ config: { name: 'discovery-test', compatibilityDate: '2026-09-25',
  manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response(null); } }' } } },
  env: { DB: binding('discovery'), POPULATED: binding('discovery-v12-populated') } } }] });
try {
  const schema = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name";
  const database = await runtime.getD1Database('DB'); await database.batch(SCHEMA_STATEMENTS.map(sql => database.prepare(sql)));
  await runDiscoveryFlow(d1Executor(database));

  const populated = await runtime.getD1Database('POPULATED'); await populated.batch(SCHEMA_V12_STATEMENTS.map(sql => populated.prepare(sql)));
  const written = await populateSchema12Discovery(d1Executor(populated));
  await populated.batch(schemaUpgradeStatements(12).map(sql => populated.prepare(sql)));
  assert.deepEqual((await populated.prepare(schema).all()).results, (await database.prepare(schema).all()).results);
  await checkSchema12Discovery(d1Executor(populated), written);
  process.stdout.write('PASS: workerd D1 records where an issue was found, shows both directions, refuses an unknown source, treats a changed link on replay as a request conflict, holds nothing back, and the schema 12 to 13 upgrade adds the canonical links table\n');
} finally { await runtime.dispose(); }
