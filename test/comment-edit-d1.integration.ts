// Runs the comment edit flows on local workerd D1; test/comment-edit.test.ts runs them on local SQLite.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { d1Executor } from '../src/service/d1.ts';
import { SCHEMA_STATEMENTS, schemaUpgradeStatements } from '../src/records/persistence/persistence.ts';
import { SCHEMA_V9_STATEMENTS } from '../src/records/persistence/schema-v9.ts';
import { checkSchema9Upgrade, populateSchema9, readEvents, runCommentEditFlow } from './fixtures/comment-edit-flow.ts';
import { runChangeFeedFlow } from './fixtures/change-feed-flow.ts';

const modulePath = process.argv[2];
const { Miniflare } = await import(modulePath ? pathToFileURL(modulePath).href : 'miniflare');
const binding = (name: string) => ({ type: 'd1', name });
const runtime = new Miniflare({ workers: [{ config: { name: 'comment-edit-test', compatibilityDate: '2026-09-25',
  manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response(null); } }' } } },
  env: { DB: binding('comment-edit'), POPULATED: binding('comment-edit-v9-populated'), EMPTY: binding('comment-edit-v9-empty') } } }] });
try {
  const schema = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name";
  const database = await runtime.getD1Database('DB'); await database.batch(SCHEMA_STATEMENTS.map(sql => database.prepare(sql)));
  await runCommentEditFlow(d1Executor(database));

  const populated = await runtime.getD1Database('POPULATED'); await populated.batch(SCHEMA_V9_STATEMENTS.map(sql => populated.prepare(sql)));
  const written = await populateSchema9(d1Executor(populated));
  const before = await readEvents(d1Executor(populated));
  await populated.batch(schemaUpgradeStatements(9).map(sql => populated.prepare(sql)));
  assert.deepEqual((await populated.prepare(schema).all()).results, (await database.prepare(schema).all()).results);
  await checkSchema9Upgrade(d1Executor(populated), written, before);

  const empty = await runtime.getD1Database('EMPTY'); await empty.batch(SCHEMA_V9_STATEMENTS.map(sql => empty.prepare(sql)));
  await empty.batch(schemaUpgradeStatements(9).map(sql => empty.prepare(sql)));
  assert.equal((await runChangeFeedFlow(d1Executor(empty))).length, 66);
  process.stdout.write('PASS: workerd D1 comment edits accept only the author at the observed version, refuse every other edit without an event, and the schema 9 to 10 rebuild keeps each event at its seq while every trigger records after it\n');
} finally { await runtime.dispose(); }
