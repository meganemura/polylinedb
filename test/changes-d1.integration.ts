// Runs the shared change feed flow on local workerd D1; test/changes.test.ts runs it on local SQLite.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { d1Executor } from '../src/service/d1.ts';
import { SCHEMA_STATEMENTS, schemaUpgradeStatements } from '../src/records/persistence.ts';
import { SCHEMA_V6_STATEMENTS } from '../src/records/schema-v6.ts';
import { executeOperation, parseOperation } from '../src/records/index.ts';
import { runChangeFeedFlow } from './fixtures/change-feed-flow.ts';
const modulePath = process.argv[2];
const { Miniflare } = await import(modulePath ? pathToFileURL(modulePath).href : 'miniflare');
const binding = (name: string) => ({ type: 'd1', name });
const runtime = new Miniflare({ workers: [{ config: { name: 'changes-test', compatibilityDate: '2026-09-25', manifest: { mainModule: 'index.js', modules: { 'index.js': { type: 'esm', contents: 'export default { fetch() { return new Response(null); } }' } } }, env: { DB: binding('changes-test'), DB6: binding('changes-v6-test') } } }] });
try {
  const database = await runtime.getD1Database('DB'); await database.batch(SCHEMA_STATEMENTS.map(sql => database.prepare(sql)));
  assert.equal((await runChangeFeedFlow(d1Executor(database))).length, 41);

  const legacy = await runtime.getD1Database('DB6'); await legacy.batch(SCHEMA_V6_STATEMENTS.map(sql => legacy.prepare(sql)));
  const schema = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name";
  await assert.rejects(executeOperation(d1Executor(legacy), parseOperation({ op: 'create', prefix: 'cf', request_id: crypto.randomUUID(), tool: 'feed', project: 'feed', body: 'old schema' }), 'alice'), /change_writer/);
  await legacy.batch(schemaUpgradeStatements(6).map(sql => legacy.prepare(sql)));
  assert.deepEqual((await legacy.prepare(schema).all()).results, (await database.prepare(schema).all()).results);
  await executeOperation(d1Executor(legacy), parseOperation({ op: 'create', prefix: 'cf', request_id: crypto.randomUUID(), tool: 'feed', project: 'feed', body: 'upgraded' }), 'alice');
  const upgraded = await executeOperation(d1Executor(legacy), parseOperation({ op: 'changes', since: 0 }), 'reader');
  assert.ok('next_since' in upgraded);
  assert.deepEqual(upgraded.changes.map(({ seq, issue_id, kind }) => ({ seq, issue_id, kind })), [{ seq: 1, issue_id: 'cf-1', kind: 'created' }]);
  process.stdout.write('PASS: workerd D1 records the shared change feed flow; rejected writes and replays record nothing; paging, cursor errors, retention, rotation and the schema 6 upgrade match local SQLite\n');
} finally { await runtime.dispose(); }
