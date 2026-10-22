import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  devDependencies: { vite: string };
  overrides: { '@modelcontextprotocol/sdk': string; hono: string };
};
const doc = readFileSync(new URL('../docs/dependencies.md', import.meta.url), 'utf8');

test('the dependency record matches the vite pin and the SDK and hono overrides', () => {
  const row = doc.match(/\| `vite` \| `([^`]+)` \|/);
  assert.ok(row, 'the record has a vite row');
  assert.equal(row[1], manifest.devDependencies.vite);
  assert.match(doc, new RegExp(`The override selects @modelcontextprotocol/sdk ${manifest.overrides['@modelcontextprotocol/sdk']}\\.`));
  assert.match(doc, new RegExp(`The override selects hono ${manifest.overrides.hono}\\.`));
  assert.match(doc, /the exact override selects 1\.31\.0/);
});
