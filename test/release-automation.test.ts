// Pins the release decisions: which version a push releases, and when a re-run skips npm publish.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { publishDecision, tarballIntegrity } from '../scripts/npm-release.ts';
import { manifestVersion, releaseOutputs, tagDecision } from '../scripts/release-version.ts';

const lock = (version: string, root = version) => ({ version, packages: { '': { version: root } } });

test('the version comes from package.json and both lockfile versions must match it', () => {
  assert.equal(manifestVersion({ version: '1.2.3' }, lock('1.2.3')), '1.2.3');
  assert.throws(() => manifestVersion({ version: '1.2' }, lock('1.2')), /must be X\.Y\.Z/);
  assert.throws(() => manifestVersion({ version: 'v1.2.3' }, lock('v1.2.3')), /must be X\.Y\.Z/);
  assert.throws(() => manifestVersion({ version: '1.2.3' }, lock('1.2.2', '1.2.3')), /package-lock\.json version 1\.2\.2/);
  assert.throws(() => manifestVersion({ version: '1.2.3' }, lock('1.2.3', '1.2.2')), /packages\[""\]\.version 1\.2\.2/);
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const repositoryLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(manifestVersion(manifest, repositoryLock), manifest.version);
});

test('a missing tag releases, an existing tag releases nothing, and a failed lookup fails', () => {
  assert.equal(tagDecision(2, 'v1.2.3'), 'release');
  assert.equal(tagDecision(0, 'v1.2.3'), 'skip');
  assert.throws(() => tagDecision(128, 'v1.2.3'), /git ls-remote failed for v1\.2\.3 with status 128/);
  assert.throws(() => tagDecision(null, 'v1.2.3'), /status null/);
  assert.equal(releaseOutputs('1.2.3', 'release'), 'tag=v1.2.3\nversion=1.2.3\n');
  assert.equal(releaseOutputs('1.2.3', 'skip'), 'tag=\nversion=\n');
});

test('npm publish runs for a new version and is skipped only for the same tarball', () => {
  const expected = tarballIntegrity(new TextEncoder().encode('tarball'));
  assert.match(expected, /^sha512-[A-Za-z0-9+/]+=*$/);
  assert.equal(publishDecision({ status: 0, stdout: '', stderr: '' }, expected), 'publish');
  assert.equal(publishDecision({ status: 0, stdout: '\n', stderr: '' }, expected), 'publish');
  assert.equal(publishDecision({ status: 1, stdout: '', stderr: 'npm error code E404\nnpm error 404 Not Found' }, expected), 'publish');
  assert.equal(publishDecision({ status: 0, stdout: JSON.stringify(expected), stderr: '' }, expected), 'skip');
  assert.throws(() => publishDecision({ status: 0, stdout: JSON.stringify('sha512-other'), stderr: '' }, expected), /already has this version with integrity sha512-other/);
  assert.throws(() => publishDecision({ status: 1, stdout: '', stderr: 'npm error code ETIMEDOUT' }, expected), /npm view failed with status 1: npm error code ETIMEDOUT/);
  assert.throws(() => publishDecision({ status: 0, stdout: 'not json', stderr: '' }, expected), /unexpected output/);
});
