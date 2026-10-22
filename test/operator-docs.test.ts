import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SCHEMA_VERSION } from '../src/records/schema.ts';
import { help } from '../src/cli-help.ts';

const memory = readFileSync(new URL('../docs/memory.md', import.meta.url), 'utf8');
const cutover = readFileSync(new URL('../docs/local-cloud-cutover.md', import.meta.url), 'utf8');
const claims = readFileSync(new URL('../docs/claims.md', import.meta.url), 'utf8');

test('upgrade, cutover, and claim docs name the schema the CLI upgrades to', () => {
  const current = `schema ${SCHEMA_VERSION}`;
  assert.match(help, new RegExp(`store to ${current}\\.`));
  assert.match(help, /to v8 without touching a store/);
  assert.match(memory, new RegExp(`upgrades it to ${current} in one transaction`));
  assert.match(memory, /writes snapshot 8/);
  assert.match(memory, /accepts snapshot 8 only/);
  assert.doesNotMatch(memory, /upgrades it to schema 5/);
  assert.doesNotMatch(memory, /snapshot-v4\.json/);
  assert.match(cutover, new RegExp(`These instructions describe ${current}\\.`));
  assert.match(cutover, new RegExp(`canonical ${current}`));
  assert.doesNotMatch(cutover, /canonical schema 8/);
  assert.match(claims, new RegExp(`current source with ${current} and snapshot 8`));
  assert.doesNotMatch(claims, /current source with schema 8/);
});
