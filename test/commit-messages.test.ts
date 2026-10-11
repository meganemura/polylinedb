// Pins the pushed-range check that keeps pd issue ids out of commit messages.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { offendingCommits, pdIssueIds, pushedRange } from '../scripts/commit-messages.ts';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(cwd: string, message: string): string {
  git(cwd, 'commit', '--allow-empty', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

test('pd issue ids are found, including child ids, and words about pd are not', () => {
  assert.deepEqual(pdIssueIds('fix: close pd-163 and PD-65.3'), ['pd-163', 'PD-65.3']);
  assert.deepEqual(pdIssueIds('docs: remove pd issue ids; pd 0.4.0 stays; upd-1 is not an id'), []);
});

test('only the pushed range is checked, and a new branch checks its tip alone', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'commit-messages-'));
  try {
    git(cwd, 'init', '-q');
    const old = commit(cwd, 'chore: older history names pd-1');
    const clean = commit(cwd, 'fix(ui): describe the change in words');
    assert.deepEqual(offendingCommits(pushedRange(old, clean, cwd), cwd), []);

    const named = commit(cwd, 'fix: pd-163\n\nBody names pd-65.5 too.');
    assert.deepEqual(offendingCommits(pushedRange(old, named, cwd), cwd), [{ sha: named, ids: ['pd-163', 'pd-65.5'] }]);

    assert.deepEqual(offendingCommits(pushedRange('0'.repeat(40), clean, cwd), cwd), []);
    assert.deepEqual(offendingCommits(pushedRange('f'.repeat(40), named, cwd), cwd), [{ sha: named, ids: ['pd-163', 'pd-65.5'] }]);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
