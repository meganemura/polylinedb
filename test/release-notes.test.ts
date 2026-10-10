// Pins changelog section extraction, including the real 0.4.0 and 0.3.1 headings.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { releaseNotes } from '../scripts/release-notes.ts';

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const repository = 'https://github.com/meganemura/polylinedb';
const install = (version: string) => `## Install\n\n\`\`\`sh\nnpm install -g polylinedb@${version}\npd --help\n\`\`\`\n`;

test('0.4.0 notes keep the dated section and add the install block', () => {
  const notes = releaseNotes(changelog, '0.4.0', repository);
  assert.match(notes, /^- Let an object entry in the cloud `ACCESS_ACTORS` roster/m);
  assert.match(notes, /^### Upgrade from 0\.3\.1$/m);
  assert.doesNotMatch(notes, /^## 0\.4\.0/m);
  assert.doesNotMatch(notes, /^## 0\.3\.1/m);
  assert.ok(notes.endsWith(install('0.4.0')));
});

test('0.3.1 notes stop at the next version and keep subsections', () => {
  const notes = releaseNotes(changelog, '0.3.1', repository);
  assert.match(notes, /^- Distinguish denied authentication state access/m);
  assert.match(notes, /^### Upgrade from supported older versions$/m);
  assert.match(notes, /docs\/d1-migration\.md#upgrade-an-existing-schema-2-3-4-or-5-deployment/);
  assert.match(notes, /^```sh\nnpm install --global polylinedb@0\.3\.1$/m);
  assert.doesNotMatch(notes, /^## 0\.3\.1/m);
  assert.doesNotMatch(notes, /^## 0\.2\.0/m);
  assert.ok(notes.endsWith(install('0.3.1')));
});

test('an undated heading and a final section are accepted', () => {
  const notes = releaseNotes('## 1.2.3\n\n- First\n\n### Detail\n\nKept\n', '1.2.3', repository);
  assert.equal(notes, `\n- First\n\n### Detail\n\nKept\n\n\n${install('1.2.3')}`);
});

test('a longer version heading does not satisfy a shorter version', () => {
  const notes = releaseNotes('## 0.4.0\n\n- Exact\n\n## 0.4.01\n\n- Longer\n', '0.4.0', repository);
  assert.match(notes, /- Exact/);
  assert.doesNotMatch(notes, /- Longer/);
});

test('missing, empty, duplicate, and invalid sections fail clearly', () => {
  assert.throws(() => releaseNotes('# Changelog\n', '1.2.3', repository), /no section for 1\.2\.3/);
  assert.throws(() => releaseNotes('## 1.2.3\n\n\n## 1.2.4\n\n- Later\n', '1.2.3', repository), /section for 1\.2\.3 is empty/);
  assert.throws(() => releaseNotes('## 1.2.3\n\n- One\n\n## 1.2.3\n\n- Two\n', '1.2.3', repository), /more than one section/);
  assert.throws(() => releaseNotes('## 1.2\n\n- No\n', '1.2', repository), /Invalid version/);
  assert.throws(() => releaseNotes('## 1.2.3-beta\n\n- No\n', '1.2.3', repository), /no section for 1\.2\.3/);
  assert.throws(() => releaseNotes('## 1.2.3 (2026-10-09) extra\n\n- No\n', '1.2.3', repository), /no section for 1\.2\.3/);
});

test('the command prints the real 0.4.0 notes and fails for a missing section', () => {
  const script = fileURLToPath(new URL('../scripts/release-notes.ts', import.meta.url));
  const root = fileURLToPath(new URL('..', import.meta.url));
  const printed = spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, RELEASE_VERSION: '0.4.0' },
    encoding: 'utf8',
  });
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, releaseNotes(changelog, '0.4.0', repository));
  const missing = spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, RELEASE_VERSION: '9.9.9' },
    encoding: 'utf8',
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no section for 9\.9\.9/);
  assert.equal(missing.stdout, '');
});
