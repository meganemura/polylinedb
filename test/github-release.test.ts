// Decides tag and release creation without calling GitHub.
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  annotatedTagRequest, ensureRelease, ghClient, interpretGh, parseAnnotatedTag, parseReleaseRecord, parseTagRef,
  releaseRequest, releaseTitle, runRelease, tagMessage, type ReleaseClient, type ReleaseRecord, type TagRef,
} from '../scripts/github-release.ts';

const commit = '24d1c92e2ae8b184916da54f97fe3eaf45ed17a8';
const tagObject = 'aeb55a7868a3c5b25fa0646f8cc46717fa90242f';
const notes = 'Notes\n\n## Install\n\n```sh\nnpm install -g polylinedb@1.2.3\npd --help\n```\n';

function client(options: { refs?: TagRef[]; release?: ReleaseRecord | null; commit?: string; tagName?: string } = {}) {
  const calls: string[] = [];
  const created: { tag?: { sha: string }; ref?: { ref: string; sha: string }; release?: { tag: string; title: string; notes: string } } = {};
  const github: ReleaseClient = {
    async matchingRefs(tag) {
      calls.push(`refs ${tag}`);
      return options.refs ?? [];
    },
    async annotatedTag(sha) {
      calls.push(`tag ${sha}`);
      return { tag: options.tagName ?? 'v1.2.3', object: { type: 'commit', sha: options.commit ?? commit } };
    },
    async createAnnotatedTag(input) {
      calls.push('create-tag');
      created.tag = { sha: tagObject };
      assert.equal(input.message, tagMessage('1.2.3'));
      assert.equal(input.commit, commit);
      return { sha: tagObject };
    },
    async createRef(input) {
      calls.push('create-ref');
      created.ref = input;
    },
    async releaseByTag(tag) {
      calls.push(`release ${tag}`);
      return options.release === undefined ? null : options.release;
    },
    async createRelease(input) {
      calls.push('create-release');
      created.release = input;
    },
  };
  return { github, calls, created };
}

test('a missing tag and release are created on the release commit', async () => {
  const fake = client();
  const outcome = await ensureRelease(fake.github, { version: '1.2.3', commit, notes });
  assert.deepEqual(outcome, { tag: 'created', release: 'created' });
  assert.deepEqual(fake.calls, ['refs v1.2.3', 'create-tag', 'create-ref', 'release v1.2.3', 'create-release']);
  assert.deepEqual(fake.created.ref, { ref: 'refs/tags/v1.2.3', sha: tagObject });
  assert.equal(fake.created.release?.title, releaseTitle('1.2.3'));
  assert.equal(fake.created.release?.notes, notes);
});

test('an annotated tag on the same commit and a matching release are verified', async () => {
  const fake = client({
    refs: [{ ref: 'refs/tags/v1.2.3', object: { type: 'tag', sha: tagObject } }, { ref: 'refs/tags/v1.2.3-rc', object: { type: 'commit', sha: commit } }],
    release: { tag_name: 'v1.2.3', name: 'polylinedb 1.2.3', body: notes, draft: false, prerelease: false },
  });
  const outcome = await ensureRelease(fake.github, { version: '1.2.3', commit, notes });
  assert.deepEqual(outcome, { tag: 'verified', release: 'verified' });
  assert.deepEqual(fake.calls, ['refs v1.2.3', `tag ${tagObject}`, 'release v1.2.3']);
  assert.equal(fake.created.release, undefined);
});

test('a tag that points elsewhere, a lightweight tag, and a draft release fail', async () => {
  const elsewhere = client({
    refs: [{ ref: 'refs/tags/v1.2.3', object: { type: 'tag', sha: tagObject } }],
    commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  await assert.rejects(() => ensureRelease(elsewhere.github, { version: '1.2.3', commit, notes }), /points at a{40}/);
  const lightweight = client({
    refs: [{ ref: 'refs/tags/v1.2.3', object: { type: 'commit', sha: commit } }],
  });
  await assert.rejects(() => ensureRelease(lightweight.github, { version: '1.2.3', commit, notes }), /not an annotated tag/);
  assert.deepEqual(lightweight.calls, ['refs v1.2.3']);
  const draft = client({
    refs: [{ ref: 'refs/tags/v1.2.3', object: { type: 'tag', sha: tagObject } }],
    release: { tag_name: 'v1.2.3', name: 'polylinedb 1.2.3', body: notes, draft: true, prerelease: false },
  });
  await assert.rejects(() => ensureRelease(draft.github, { version: '1.2.3', commit, notes }), /draft/);
  assert.equal(draft.created.release, undefined);
});

test('a different title or notes fails without creating another release', async () => {
  const titled = client({
    refs: [{ ref: 'refs/tags/v1.2.3', object: { type: 'tag', sha: tagObject } }],
    release: { tag_name: 'v1.2.3', name: 'other', body: notes, draft: false, prerelease: false },
  });
  await assert.rejects(() => ensureRelease(titled.github, { version: '1.2.3', commit, notes }), /does not match/);
  const rewritten = client({
    refs: [{ ref: 'refs/tags/v1.2.3', object: { type: 'tag', sha: tagObject } }],
    release: { tag_name: 'v1.2.3', name: 'polylinedb 1.2.3', body: 'other\n', draft: false, prerelease: false },
  });
  await assert.rejects(() => ensureRelease(rewritten.github, { version: '1.2.3', commit, notes }), /does not match/);
});

test('the command reads notes and releases the pushed workflow SHA', async context => {
  const root = mkdtempSync(join(tmpdir(), 'pd-release-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const notesPath = join(root, 'notes.md');
  writeFileSync(notesPath, notes);
  const fake = client();
  const outcome = await runRelease({
    RELEASE_VERSION: '1.2.3', GITHUB_SHA: commit, RELEASE_NOTES_FILE: notesPath,
  }, fake.github);
  assert.equal(outcome.release, 'created');
  assert.equal(fake.created.tag?.sha, tagObject);
  await assert.rejects(() => runRelease({
    RELEASE_VERSION: '1.2.3', GITHUB_SHA: 'main', RELEASE_NOTES_FILE: notesPath,
  }, fake.github), /GITHUB_SHA must be a full lowercase SHA/);
  await assert.rejects(() => runRelease({ RELEASE_VERSION: '1.2.3', RELEASE_NOTES_FILE: notesPath }, fake.github), /GITHUB_SHA must be a full lowercase SHA/);
});

test('GitHub responses keep the annotated tag distinct from its commit', () => {
  const ref = parseTagRef({ ref: 'refs/tags/v0.4.0', object: { sha: tagObject, type: 'tag' } });
  assert.equal(ref.object.sha, tagObject);
  assert.equal(parseAnnotatedTag({ tag: 'v0.4.0', message: 'polylinedb 0.4.0\n', object: { sha: commit, type: 'commit' } }).object.sha, commit);
  assert.equal(parseReleaseRecord({ tag_name: 'v0.4.0', name: 'polylinedb 0.4.0', body: notes, draft: false, prerelease: false }).name, 'polylinedb 0.4.0');
  assert.equal(interpretGh('GET', 1, '{"message":"Not Found","status":"404"}', 'gh: Not Found (HTTP 404)'), null);
  assert.throws(() => interpretGh('POST', 1, '', 'gh: Validation Failed'), /Validation Failed/);
  assert.deepEqual(annotatedTagRequest({ tag: 'v1.2.3', message: tagMessage('1.2.3'), commit }, '2026-10-09T00:00:00.000Z'), {
    tag: 'v1.2.3',
    message: 'polylinedb 1.2.3\n',
    object: commit,
    type: 'commit',
    tagger: {
      name: 'github-actions[bot]',
      email: '41898282+github-actions[bot]@users.noreply.github.com',
      date: '2026-10-09T00:00:00.000Z',
    },
  });
  assert.equal(releaseRequest({ tag: 'v1.2.3', title: 'polylinedb 1.2.3', notes }).make_latest, 'true');
});

// A stand-in `gh` on PATH records each call's arguments and standard input, and answers like the GitHub API.
const fakeGh = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
const input = args.includes('--input') ? readFileSync(0, 'utf8') : '';
appendFileSync(process.env.GH_FAKE_LOG, JSON.stringify({ args, input }) + '\\n');
const path = args[3];
if (path.endsWith('/git/matching-refs/tags/v1.2.3')) process.stdout.write('[]');
else if (path.endsWith('/git/tags')) process.stdout.write(JSON.stringify({ sha: '${tagObject}' }));
else if (path.endsWith('/releases/tags/v1.2.3')) { process.stderr.write('gh: Not Found (HTTP 404)'); process.exit(1); }
else process.stdout.write('{}');
`;

test('the gh client sends each POST body on standard input with --input -', async context => {
  const root = mkdtempSync(join(tmpdir(), 'pd-gh-'));
  const path = process.env.PATH;
  context.after(() => {
    process.env.PATH = path;
    delete process.env.GH_FAKE_LOG;
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, 'gh'), fakeGh);
  chmodSync(join(root, 'gh'), 0o755);
  process.env.PATH = `${root}:${path}`;
  process.env.GH_FAKE_LOG = join(root, 'calls.jsonl');

  const outcome = await ensureRelease(ghClient('owner/repo', () => '2026-10-12T00:00:00.000Z'), { version: '1.2.3', commit, notes });
  assert.deepEqual(outcome, { tag: 'created', release: 'created' });
  const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => call.args), [
    ['api', '--method', 'GET', 'repos/owner/repo/git/matching-refs/tags/v1.2.3'],
    ['api', '--method', 'POST', 'repos/owner/repo/git/tags', '--input', '-'],
    ['api', '--method', 'POST', 'repos/owner/repo/git/refs', '--input', '-'],
    ['api', '--method', 'GET', 'repos/owner/repo/releases/tags/v1.2.3'],
    ['api', '--method', 'POST', 'repos/owner/repo/releases', '--input', '-'],
  ]);
  assert.deepEqual(JSON.parse(calls[1].input), {
    tag: 'v1.2.3', message: 'polylinedb 1.2.3\n', object: commit, type: 'commit',
    tagger: { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com', date: '2026-10-12T00:00:00.000Z' },
  });
  assert.deepEqual(JSON.parse(calls[2].input), { ref: 'refs/tags/v1.2.3', sha: tagObject });
  assert.deepEqual(JSON.parse(calls[4].input), {
    tag_name: 'v1.2.3', name: 'polylinedb 1.2.3', body: notes, draft: false, prerelease: false, make_latest: 'true',
  });
});
