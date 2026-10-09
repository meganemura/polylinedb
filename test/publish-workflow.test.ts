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

test('publish stays the approved npm job and release follows it', () => {
  assert.deepEqual([...job.keys()], ['publish', 'release']);
  const release = job.get('release') ?? '';
  const npm = job.get('publish') ?? '';
  assert.match(npm, /^    if: github\.ref == 'refs\/heads\/main'$/m);
  assert.match(npm, /^    environment: publish$/m);
  assert.match(npm, /    permissions:\n      contents: read\n      id-token: write\n/);
  assert.doesNotMatch(npm, /contents: write/);
  assert.match(release, /^    needs: publish$/m);
  assert.match(release, /^    if: github\.ref == 'refs\/heads\/main'$/m);
  assert.match(release, /    permissions:\n      contents: write\n/);
  assert.doesNotMatch(release, /id-token/);
  assert.doesNotMatch(release, /environment:/);
  assert.match(publish, /^permissions:\n  contents: read$/m);
  assert.equal(publish.match(/id-token: write/g)?.length, 1);
  assert.equal(publish.match(/contents: write/g)?.length, 1);
  assert.equal(publish.match(/persist-credentials: false/g)?.length, 2);
});

test('release notes are checked before npm publish and written before the tag step', () => {
  const npm = job.get('publish') ?? '';
  const release = job.get('release') ?? '';
  const check = npm.indexOf('name: Check the release notes');
  const install = npm.indexOf('npm ci --ignore-scripts');
  const integrity = npm.indexOf('name: Verify registry integrity');
  assert.ok(check > -1 && install > check && integrity > install);
  assert.match(release, /node scripts\/release-notes\.ts/);
  assert.match(release, /node scripts\/github-release\.ts/);
  assert.ok(release.indexOf('node scripts/release-notes.ts') < release.indexOf('node scripts/github-release.ts'));
  assert.match(release, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.equal(release.split('GH_TOKEN').length, 2);
});

test('workflow actions are GitHub-owned and pinned, and inputs stay in env bindings', () => {
  const uses: string[] = [];
  for (const name of workflows) {
    const source = readFileSync(new URL(`.github/workflows/${name}`, root), 'utf8');
    for (const line of source.split('\n')) {
      const use = line.trim().replace(/^- /, '');
      if (use.startsWith('uses:')) uses.push(use);
      if (!line.includes('${{ inputs.')) continue;
      assert.match(line, /^\s+[A-Z][A-Z0-9_]*: \$\{\{ inputs\.(version|commit) \}\}$/);
    }
  }
  assert.deepEqual(uses, [
    'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  ]);
});
