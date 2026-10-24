// Pins the operations and arguments that the bundled skill names to the advertised MCP schemas and annotations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mcpAnnotationsFor, operationSchemas } from '../src/records/index.ts';

const skill = readFileSync(new URL('../skills/polylinedb/SKILL.md', import.meta.url), 'utf8');
const uses = {
  actor: [], memory_context: ['project'], memory_show: [], dependency_worklist: ['state', 'project'], show: ['id'], list: ['label'],
  claim_show: ['issue_id'], claim_acquire: ['issue_id', 'incarnation', 'session_id', 'request_id', 'ttl'],
  claim_renew: ['claim_proof', 'expected_revision'], claim_release: ['claim_proof', 'expected_revision'], claim_handoff: ['claim_proof', 'expected_revision', 'request_id', 'tip', 'summary'],
  update: ['claim_proof'], close: ['claim_proof'], comment: ['id', 'body', 'handle', 'via', 'reply_to'], comment_edit: ['id', 'comment_id', 'body', 'expected'], dependency_add: [], dependency_remove: [],
  star: ['id', 'comment_id', 'handle'], unstar: [], posts: ['project', 'handle', 'min_stars'],
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
  assert.ok(queue.includes('Nobody adds a landing-record commit.'));
  assert.ok(queue.includes('Rocky lands only under the `main-lock` claim, and only a queue tip whose Check workflow succeeded on that exact commit.'));
  assert.doesNotMatch(queue, /landing changelog commit|one commit on top of the commits being landed/);
  assert.ok(readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8').includes('[docs/releasing.md](docs/releasing.md)'));
});

test('the skill tells a new holder about an expired lease and a stalled holder to hand off', () => {
  assert.ok(skill.includes('It also returns `previous_lease`: the lease that expired without a release just before this acquisition, or `null`.'));
  assert.ok(skill.includes('read the issue comments and look for a pushed `work/<issue id>` branch'));
  assert.ok(skill.includes('Push `work/<issue id>`, write a `comment` that says what is done and what remains, set status `open` with the proof, and release the claim.'));
});

test('the skill says that in_progress needs the claim proof and that a plain handoff reopens the issue first', () => {
  assert.ok(skill.includes('`in_progress` requires the proof, for every actor, unless the issue is an epic. Without it, `update` fails with `claim_required`.'));
  assert.ok(skill.includes('For a handoff without `claim_handoff`, record the current pointers, set status `open` with the proof, and then release the issue claim.'));
});

test('the skill asks for one post per finished issue, under the claim, and a star when a lesson helped', () => {
  assert.ok(skill.includes('Post it with `comment` while you still hold the claim, before `claim_handoff` or `close`.'));
  assert.ok(skill.includes('Never put a secret, a credential, a private path, or text from a private source into a post. When there is no lesson, post nothing.'));
  assert.ok(skill.includes('When a post helped you, `star` it with your handle.'));
});
