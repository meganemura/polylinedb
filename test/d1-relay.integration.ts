// Exercises the D1 test relay against workerd and against a Node server that counts connections.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { d1Relay, d1RelayModule } from './fixtures/d1-relay.ts';

const modulePath = process.argv[2];
const { Miniflare } = await import(modulePath ? pathToFileURL(modulePath).href : 'miniflare');
const runtime = new Miniflare({ workers: [{ config: {
  name: 'relay-test', compatibilityDate: '2026-09-25', manifest: d1RelayModule,
  env: { DB: { type: 'd1', name: 'relay-test' } },
} }] });
const blockEventLoop = (milliseconds: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

try {
  const database = d1Relay(await runtime.ready, 'DB');
  assert.deepEqual((await database.prepare('SELECT ? AS value').bind(1).all()).results, [{ value: 1 }]);
  blockEventLoop(6000);
  assert.deepEqual((await database.prepare('SELECT ? AS value').bind(2).all()).results, [{ value: 2 }]);

  await database.batch([database.prepare('CREATE TABLE relay_rows (id INTEGER PRIMARY KEY)'), database.prepare('INSERT INTO relay_rows (id) VALUES (1)')]);
  await assert.rejects(database.prepare('INSERT INTO relay_rows (id) VALUES (?)').bind(1).run(), (error: Error) => {
    assert.equal(error.message, 'D1_ERROR: UNIQUE constraint failed: relay_rows.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)');
    assert.equal((error.cause as Error).message, 'UNIQUE constraint failed: relay_rows.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)');
    return true;
  });
  process.stdout.write('PASS: workerd D1 relay call after a 6 s blocked event loop, constraint failure fields\n');
} finally { await runtime.dispose(); }

let connections = 0;
const server = createServer((request, response) => {
  request.resume();
  request.on('end', () => response.end('[{"results":[],"success":true,"meta":{}}]'));
}).on('connection', () => { connections += 1; });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const relay = d1Relay(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`), 'DB');
  await relay.prepare('SELECT 1').all();
  await relay.prepare('SELECT 1').all();
  await relay.batch([relay.prepare('SELECT 1')]);
  assert.equal(connections, 1);
  blockEventLoop(2500);
  await relay.prepare('SELECT 1').all();
  assert.equal(connections, 2);
  process.stdout.write('PASS: relay reuses one connection for back-to-back calls and opens a fresh one after a 2.5 s blocked pause\n');
} finally { server.closeAllConnections(); server.close(); }
