// Decides tag and release creation without calling GitHub.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  annotatedTagRequest, ensureRelease, interpretGh, parseAnnotatedTag, parseReleaseRecord, parseTagRef,
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

test('a missing tag and release are created on the approved commit', async () => {
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

test('the command reads notes and refuses a commit that is not the workflow SHA', async context => {
  const root = mkdtempSync(join(tmpdir(), 'pd-release-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const notesPath = join(root, 'notes.md');
  writeFileSync(notesPath, notes);
  const fake = client();
  const outcome = await runRelease({
    RELEASE_VERSION: '1.2.3', APPROVED_COMMIT: commit, GITHUB_SHA: commit, RELEASE_NOTES_FILE: notesPath,
  }, fake.github);
  assert.equal(outcome.release, 'created');
  await assert.rejects(() => runRelease({
    RELEASE_VERSION: '1.2.3', APPROVED_COMMIT: commit, GITHUB_SHA: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', RELEASE_NOTES_FILE: notesPath,
  }, fake.github), /GITHUB_SHA does not match/);
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
