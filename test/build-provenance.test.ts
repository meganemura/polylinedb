// Isolated repositories prove that build identity cannot borrow a parent repository's commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCommit } from '../vite.config.ts';

test('build provenance requires the exact clean repository and includes untracked files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'polylinedb-provenance-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    assert.equal(buildCommit(directory), null);
    git('init');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(directory, 'source.ts'), 'export const version = 1;\n');
    git('add', 'source.ts');
    git('commit', '-m', 'Add fixture source');
    const head = git('rev-parse', 'HEAD');
    assert.match(head, /^[a-f0-9]{40}$/);
    assert.equal(buildCommit(directory), head);
    const nested = join(directory, 'nested');
    mkdirSync(nested);
    assert.equal(buildCommit(nested), null);
    writeFileSync(join(directory, 'source.ts'), 'export const version = 2;\n');
    assert.equal(buildCommit(directory), null);
    git('checkout', '--', 'source.ts');
    git('config', 'status.showUntrackedFiles', 'no');
    writeFileSync(join(directory, 'extra.ts'), 'export const extra = true;\n');
    assert.equal(buildCommit(directory), null);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
