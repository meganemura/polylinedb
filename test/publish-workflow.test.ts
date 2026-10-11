// Pins the publish workflow's job order, permissions, and action SHAs.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('..', import.meta.url);
const workflows = readdirSync(new URL('.github/workflows/', root)).filter(name => name.endsWith('.yml')).sort();
const publish = readFileSync(new URL('.github/workflows/publish.yml', root), 'utf8');

function jobs(source: string): Map<string, string> {
  const lines = source.split('\n');
  const start = lines.indexOf('jobs:');
  assert.ok(start >= 0);
  const found = new Map<string, string[]>();
  let name: string | null = null;
  for (const line of lines.slice(start + 1)) {
    const header = /^  ([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header?.[1]) {
      name = header[1];
      found.set(name, []);
      continue;
    }
    if (name) found.get(name)?.push(line);
  }
  return new Map([...found].map(([key, value]) => [key, value.join('\n')]));
}

const job = jobs(publish);

test('a push to main that changes package.json starts the workflow, with no manual path', () => {
  assert.match(publish, /^on:\n  push:\n    branches: \[main\]\n    paths: \[package\.json\]\n\n/m);
  assert.doesNotMatch(publish, /workflow_dispatch|\binputs\b|APPROVED_COMMIT/);
  assert.match(publish, /^permissions: \{\}$/m);
  assert.match(publish, /^concurrency:\n  group: npm-publish\n  cancel-in-progress: false$/m);
});

test('check gates publish, publish holds the only OIDC grant, and release holds the only write grant', () => {
  assert.deepEqual([...job.keys()], ['check', 'publish', 'release']);
  const check = job.get('check') ?? '';
  const npm = job.get('publish') ?? '';
  const release = job.get('release') ?? '';
  assert.match(check, /    permissions:\n      contents: read\n    outputs:\n      tag: \$\{\{ steps\.version\.outputs\.tag \}\}\n      version: \$\{\{ steps\.version\.outputs\.version \}\}\n/);
  assert.match(check, /run: node scripts\/release-version\.ts/);
  assert.doesNotMatch(check, /environment:|needs:/);
  assert.match(npm, /^    needs: check$/m);
  assert.match(npm, /^    if: needs\.check\.outputs\.tag != ''$/m);
  assert.match(npm, /^    environment: publish$/m);
  assert.match(npm, /    permissions:\n      contents: read\n      id-token: write\n/);
  assert.match(release, /^    needs: \[check, publish\]$/m);
  assert.match(release, /    permissions:\n      contents: write\n/);
  assert.doesNotMatch(release, /id-token|environment:/);
  assert.equal(publish.match(/id-token: write/g)?.length, 1);
  assert.equal(publish.match(/contents: write/g)?.length, 1);
  assert.equal(publish.match(/environment:/g)?.length, 1);
  assert.equal(publish.match(/persist-credentials: false/g)?.length, 3);
});

test('publish verifies before npm, skips an already published identical tarball, and always checks the registry', () => {
  const npm = job.get('publish') ?? '';
  const order = ['name: Check the release notes', 'npm ci --ignore-scripts', 'npm run typecheck', 'npm run check:architecture', 'npm test',
    'npm run test:d1', 'npm exec -- vite build', 'node test/worker.integration.ts', 'npm audit', 'name: Verify the distributable',
    'decision="$(node scripts/npm-release.ts)"', '--dry-run', 'name: Verify registry integrity'];
  const positions = order.map(step => npm.indexOf(step));
  assert.ok(positions.every(position => position > -1), String(positions));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.match(npm, /if \[ "\$decision" = publish \]; then\n {12}npm publish "\$RELEASE_TARBALL" --dry-run/);
  assert.doesNotMatch(npm.slice(npm.indexOf('name: Verify registry integrity')), /^\s+if:/m);
});

test('release writes the notes before it tags the pushed commit', () => {
  const release = job.get('release') ?? '';
  assert.match(release, /node scripts\/release-notes\.ts/);
  assert.match(release, /node scripts\/github-release\.ts/);
  assert.ok(release.indexOf('node scripts/release-notes.ts') < release.indexOf('node scripts/github-release.ts'));
  assert.match(release, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.equal(publish.split('GH_TOKEN').length, 2);
});

test('workflow actions are GitHub-owned and pinned, and expressions stay in env bindings', () => {
  const uses: string[] = [];
  for (const name of workflows) {
    const source = readFileSync(new URL(`.github/workflows/${name}`, root), 'utf8');
    for (const line of source.split('\n')) {
      const use = line.trim().replace(/^- /, '');
      if (use.startsWith('uses:')) uses.push(use);
      if (!line.includes('${{ needs.check.outputs.')) continue;
      assert.match(line, /^\s+(?:[A-Z][A-Z0-9_]*: \$\{\{ needs\.check\.outputs\.version \}\}|if: needs\.check\.outputs\.tag != '')$/);
    }
  }
  const pair = [
    'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  ];
  assert.deepEqual(uses, [...pair, ...pair, ...pair, ...pair, ...pair]);
});

test('the release guide states the rules the workflow enforces', () => {
  const guide = readFileSync(new URL('docs/releasing.md', root), 'utf8');
  for (const promise of [
    'runs on a push to `main` that changes `package.json`. It has no manual trigger.',
    'npm trusted publishing is bound to the filename `publish.yml`, so never rename the file.',
    'When the tag exists, it logs that and releases nothing.',
    'The owner\'s approval is the last gate before npm.',
    'skips `npm publish` only when the registry integrity equals the new tarball\'s integrity',
    'Nobody pushes a release tag, runs `npm publish`, or creates a GitHub Release by hand.',
    'Claude cloud sessions cannot push tags.',
    'A CLI release and a Worker deployment are separate steps.',
  ]) assert.ok(guide.includes(promise), promise);
  assert.doesNotMatch(guide, /workflow_dispatch|gh workflow run|APPROVED_SHA/);
});
