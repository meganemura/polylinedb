// Pins the operations and arguments that the bundled skill names to the advertised MCP schemas and annotations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mcpAnnotationsFor, operationSchemas } from '../src/records/index.ts';

const skill = readFileSync(new URL('../skills/polylinedb/SKILL.md', import.meta.url), 'utf8');
const uses = {
  actor: [], memory_context: ['project'], memory_show: [], dependency_worklist: ['state', 'project'], show: ['id'], list: ['label'],
  claim_show: ['issue_id'], claim_acquire: ['issue_id', 'incarnation', 'session_id', 'request_id', 'ttl'],
  claim_renew: ['claim_proof', 'expected_revision'], claim_release: ['claim_proof', 'expected_revision'],
  update: ['claim_proof'], close: ['claim_proof'], comment: ['id', 'body'], dependency_add: [], dependency_remove: [],
} as const;

test('every operation the skill names is an advertised MCP tool with the arguments the skill uses', () => {
  const schemas: Record<string, { properties: Record<string, unknown> }> = operationSchemas;
  for (const [name, args] of Object.entries(uses)) {
    assert.ok(skill.includes(`\`${name}\``), `the skill names ${name}`);
    const schema = schemas[name];
    assert.ok(schema, `${name} has a schema`);
    assert.equal(mcpAnnotationsFor(name).openWorldHint, false, `${name} has MCP annotations`);
    for (const arg of args) assert.ok(arg in schema.properties, `${name} accepts ${arg}`);
  }
  assert.deepEqual((operationSchemas.dependency_worklist.properties.state as { enum: string[] }).enum, ['ready', 'blocked']);
});

test('the skill identifies the pd connection before stopping for a missing tool', () => {
  const rules = [
    'Do not substitute another tool.',
    'Before stopping because a named tool is missing, see which connection each visible pd tool comes from.',
    'The name prefix or the namespace names that connection.',
    'Check for more than one pd connection, such as a host connector import and a configured MCP server.',
    'For example, a Codex session can show a connector import beside a configured MCP server.',
    'Use only the connection that advertises every tool this skill names.',
    'If none does, stop and report the missing names, the source of the visible tools, and that a connector import can keep the tool list from its creation time (refresh it) or that a configured server may need its own login.',
  ];
  for (const sentence of rules) assert.ok(skill.includes(sentence), sentence);
});

// A shipped skill outlives the release it was written for, so release status in its text goes stale.
test('the skill takes capabilities from advertised schemas rather than release status', () => {
  assert.doesNotMatch(skill, /\b\d+\.\d+\.\d+\b/, 'the skill names no package version');
  assert.doesNotMatch(skill, /\bschema \d/i, 'the skill names no schema number');
  assert.doesNotMatch(skill, /\bunreleased\b|\bpre-release\b|\bnot yet (released|published)\b/i, 'the skill has no release status');
});

test('the queue skill copies match and keep pd issue ids out of the changelogs and commit messages', () => {
  const queue = readFileSync(new URL('../skills/polylinedb-queue/SKILL.md', import.meta.url), 'utf8');
  assert.equal(readFileSync(new URL('../.cursor/skills/polylinedb-queue/SKILL.md', import.meta.url), 'utf8'), queue);
  assert.ok(queue.includes('Never write pd issue ids, such as `pd-149`, into either file'));
  assert.ok(queue.includes('Never write a pd issue id, such as `pd-149` or `pd-65.3`, into a commit message.'));
  assert.ok(queue.includes('as `docs/releasing.md` in the repository describes. Never push a release tag or run `npm publish` by hand.'));
  assert.ok(readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8').includes('[docs/releasing.md](docs/releasing.md)'));
});
