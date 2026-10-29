// Runs the posts flows on local workerd D1; test/posts.test.ts runs them on local SQLite.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { d1Executor } from '../src/service/d1.ts';
import { SCHEMA_STATEMENTS, schemaUpgradeStatements } from '../src/records/persistence/persistence.ts';
import { SCHEMA_V10_STATEMENTS } from '../src/records/persistence/schema-v10.ts';
import { checkSchema10Upgrade, populateSchema10, readEvents, runPostsFlow, runTimelineFlow } from './fixtures/posts-flow.ts';

const modulePath = process.argv[2];
const { Miniflare } = await import(modulePath ? pathToFileURL(modulePath).href : 'miniflare');
const binding = (name: string) => ({ type: 'd1', name });
const runtime = new Miniflare({ workers: [{ config: { name: 'posts-test', compatibilityDate: '2026-09-25',
  manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response(null); } }' } } },
  env: { DB: binding('posts'), POPULATED: binding('posts-v10-populated') } } }] });
try {
  const schema = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name";
  const database = await runtime.getD1Database('DB'); await database.batch(SCHEMA_STATEMENTS.map(sql => database.prepare(sql)));
  await runPostsFlow(d1Executor(database));
  await runTimelineFlow(d1Executor(database));

  const populated = await runtime.getD1Database('POPULATED'); await populated.batch(SCHEMA_V10_STATEMENTS.map(sql => populated.prepare(sql)));
  const written = await populateSchema10(d1Executor(populated));
  const before = await readEvents(d1Executor(populated));
  await populated.batch(schemaUpgradeStatements(10).map(sql => populated.prepare(sql)));
  assert.deepEqual((await populated.prepare(schema).all()).results, (await database.prepare(schema).all()).results);
  await checkSchema10Upgrade(d1Executor(populated), written, before);
  process.stdout.write('PASS: workerd D1 posts keep a handle, via and a same-issue reply, refuse a reply across issues, star and unstar idempotently with one event per real change, list posts by project with filters and pages, post to a project timeline with no issue or claim, and the schema 10 to 11 upgrade keeps comments and every event at its seq\n');
} finally { await runtime.dispose(); }
