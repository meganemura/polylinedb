// Pins changelog section extraction, including the real 0.4.0 and 0.3.1 headings, and absolute link targets.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { absoluteLinks, releaseNotes, repositoryUrl } from '../scripts/release-notes.ts';

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

test('0.4.0 notes have no relative links, so the published v0.4.0 body still matches on a re-run', () => {
  const notes = releaseNotes(changelog, '0.4.0', repository);
  assert.equal(notes, releaseNotes(changelog, '0.4.0', 'https://github.com/other/fork'));
  assert.doesNotMatch(notes, /github\.com\/meganemura\/polylinedb\/(?:blob|tree|raw)\//);
});

test('0.3.1 notes stop at the next version and keep subsections', () => {
  const notes = releaseNotes(changelog, '0.3.1', repository);
  assert.match(notes, /^- Distinguish denied authentication state access/m);
  assert.match(notes, /^### Upgrade from supported older versions$/m);
  assert.match(notes, /^```sh\nnpm install --global polylinedb@0\.3\.1$/m);
  assert.doesNotMatch(notes, /^## 0\.3\.1/m);
  assert.doesNotMatch(notes, /^## 0\.2\.0/m);
  assert.ok(notes.endsWith(install('0.3.1')));
});

test('0.3.1 and 0.2.0 links point at the docs as they were at the release tag', () => {
  const current = releaseNotes(changelog, '0.3.1', repository);
  assert.ok(current.includes(`[database upgrade procedure](${repository}/blob/v0.3.1/docs/d1-migration.md#upgrade-an-existing-schema-2-3-4-or-5-deployment)`));
  assert.ok(current.includes(`[claim workflow](${repository}/blob/v0.3.1/docs/claims.md)`));
  assert.doesNotMatch(current, /\]\((?!https:\/\/)/);
  const older = releaseNotes(changelog, '0.2.0', repository);
  assert.ok(older.includes(`[D1 upgrade procedure](${repository}/blob/v0.2.0/docs/d1-migration.md#upgrade-an-existing-schema-2-3-or-4-deployment)`));
});

test('the repository URL comes from the package manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(repositoryUrl(manifest), repository);
  assert.equal(repositoryUrl({ repository: 'https://github.com/owner/name' }), 'https://github.com/owner/name');
  assert.equal(repositoryUrl({ repository: { url: 'https://github.com/owner/name.git' } }), 'https://github.com/owner/name');
  for (const manifest of [{}, null, { repository: { url: 'git@github.com:owner/name.git' } }, { repository: { url: 'https://gitlab.com/owner/name' } }, { repository: 'github:owner/name' }]) {
    assert.throws(() => repositoryUrl(manifest), /repository\.url must name a GitHub repository/);
  }
});

const rewrite = (markdown: string) => absoluteLinks(markdown, repository, 'v1.2.3');
const blob = `${repository}/blob/v1.2.3`;

test('relative link targets become blob URLs at the tag and keep their anchor', () => {
  assert.equal(rewrite('See [docs](docs/claims.md).'), `See [docs](${blob}/docs/claims.md).`);
  assert.equal(rewrite('See [docs](docs/a.md#part-2).'), `See [docs](${blob}/docs/a.md#part-2).`);
  assert.equal(rewrite('See [docs](./docs/a.md#part).'), `See [docs](${blob}/docs/a.md#part).`);
  assert.equal(rewrite('See [docs](/docs/a.md).'), `See [docs](${blob}/docs/a.md).`);
  assert.equal(rewrite('See [docs](docs/../README.md?plain=1#usage).'), `See [docs](${blob}/README.md?plain=1#usage).`);
  assert.equal(rewrite('See [docs](docs/a.md "Title").'), `See [docs](${blob}/docs/a.md "Title").`);
  assert.equal(rewrite('See [docs](<docs/a b.md>).'), `See [docs](<${blob}/docs/a b.md>).`);
  assert.equal(rewrite('See [docs](docs/a_(b).md).'), `See [docs](${blob}/docs/a_(b).md).`);
  assert.equal(rewrite('See [the `pd` docs](docs/a.md).'), `See [the \`pd\` docs](${blob}/docs/a.md).`);
  assert.equal(rewrite('See [docs](docs/).'), `See [docs](${repository}/tree/v1.2.3/docs/).`);
  assert.equal(rewrite('See [root](./).'), `See [root](${repository}/tree/v1.2.3).`);
  assert.equal(rewrite('![diagram](docs/a.png)'), `![diagram](${repository}/raw/v1.2.3/docs/a.png)`);
  assert.equal(rewrite('- One [a](a.md)\n  and [b](b.md)\n- Two [c](c.md)'), `- One [a](${blob}/a.md)\n  and [b](${blob}/b.md)\n- Two [c](${blob}/c.md)`);
});

test('in-page anchors and absolute URLs stay unchanged', () => {
  for (const markdown of [
    'See [upgrade](#upgrade-from-020).',
    'See [Node](https://nodejs.org/api/typescript.html#type-stripping-in-dependencies).',
    'See [plain](http://example.com/docs/a.md).',
    'Mail [owner](mailto:owner@example.com).',
    'See [other](//example.com/docs/a.md).',
    'See [query](?tab=readme).',
    'Empty [link]().',
    'Not a link: [docs] (docs/a.md).',
    'Escaped \\[docs](docs/a.md).',
  ]) {
    assert.equal(rewrite(markdown), markdown);
  }
});

test('reference-style definitions are rewritten like inline links', () => {
  assert.equal(rewrite('See [docs][d].\n\n[d]: docs/a.md#part'), `See [docs][d].\n\n[d]: ${blob}/docs/a.md#part`);
  assert.equal(rewrite('[d]: ./docs/a.md "Title"'), `[d]: ${blob}/docs/a.md "Title"`);
  assert.equal(rewrite('[d]: <docs/a.md>'), `[d]: <${blob}/docs/a.md>`);
  assert.equal(rewrite('[d]: https://example.com/a.md'), '[d]: https://example.com/a.md');
  assert.equal(rewrite('[d]: #anchor'), '[d]: #anchor');
});

test('code spans and fenced code blocks keep their text', () => {
  for (const markdown of [
    'Run `[docs](docs/a.md)` first.',
    'Run ``a ` [docs](docs/a.md)`` first.',
    'Run `[docs](docs/a.md)\nstill code` first.',
    '```md\n[docs](docs/a.md)\n[d]: docs/a.md\n```',
    '~~~\n[docs](docs/a.md)\n~~~',
    '````\n```\n[docs](docs/a.md)\n````',
    '- Step\n\n  ```sh\n  echo [docs](docs/a.md)\n  ```',
  ]) {
    assert.equal(rewrite(markdown), markdown);
  }
  assert.equal(rewrite('```sh\necho\n```\n\nSee [docs](docs/a.md).'), `\`\`\`sh\necho\n\`\`\`\n\nSee [docs](${blob}/docs/a.md).`);
  assert.equal(rewrite('An open ` tick, then [docs](docs/a.md).'), `An open \` tick, then [docs](${blob}/docs/a.md).`);
});

test('a link that leaves the repository fails', () => {
  assert.throws(() => rewrite('See [up](../other/a.md).'), /link leaves the repository: \.\.\/other\/a\.md/);
  assert.throws(() => rewrite('[up]: docs/../../a.md'), /link leaves the repository/);
  assert.throws(() => releaseNotes('## 1.2.3\n\n- See [up](../a.md)\n', '1.2.3', repository), /link leaves the repository/);
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

test('the command prints the real 0.4.0 and 0.3.1 notes and fails for a missing section', () => {
  const script = fileURLToPath(new URL('../scripts/release-notes.ts', import.meta.url));
  const root = fileURLToPath(new URL('..', import.meta.url));
  for (const version of ['0.4.0', '0.3.1']) {
    const printed = spawnSync(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, RELEASE_VERSION: version },
      encoding: 'utf8',
    });
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(printed.stdout, releaseNotes(changelog, version, repository));
  }
  const missing = spawnSync(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, RELEASE_VERSION: '9.9.9' },
    encoding: 'utf8',
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no section for 9\.9\.9/);
  assert.equal(missing.stdout, '');
});
