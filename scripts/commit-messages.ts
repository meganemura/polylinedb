// Rejects pd issue ids in the commit messages of a pushed range.
// Only the owner's agents can read pd, so a commit describes its change in words; the pd `tip:` comment links back to git.
// The range covers only the pushed commits, so history that predates the rule is not checked again.
import { spawnSync } from 'node:child_process';

const issueIdPattern = /\bpd-\d+(?:\.\d+)*\b/gi;
const missingCommitPattern = /^0*$/;

export function pdIssueIds(message: string): string[] {
  return message.match(issueIdPattern) ?? [];
}

function git(args: string[], cwd: string): { status: number | null; stdout: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout };
}

// A new branch reports an all-zero `before`, and a force push can name a commit the clone lacks; both check `after` alone.
export function pushedRange(before: string, after: string, cwd: string): string[] {
  if (missingCommitPattern.test(before) || git(['cat-file', '-e', `${before}^{commit}`], cwd).status !== 0) return ['-1', after];
  return [`${before}..${after}`];
}

export function offendingCommits(range: string[], cwd: string): { sha: string; ids: string[] }[] {
  const log = git(['log', '--format=%H%x00%B%x1e', ...range], cwd);
  if (log.status !== 0) throw new Error(`git log failed for ${range.join(' ')}`);
  return log.stdout.split('\x1e').flatMap((entry) => {
    const [sha, message] = entry.replace(/^\n/, '').split('\0');
    if (!sha || message === undefined) return [];
    const ids = pdIssueIds(message);
    return ids.length === 0 ? [] : [{ sha, ids }];
  });
}

if (import.meta.main) {
  try {
    const after = process.env.COMMIT_RANGE_AFTER ?? '';
    if (after === '') throw new Error('COMMIT_RANGE_AFTER must name the pushed commit');
    const offending = offendingCommits(pushedRange(process.env.COMMIT_RANGE_BEFORE ?? '', after, process.cwd()), process.cwd());
    for (const { sha, ids } of offending) process.stderr.write(`${sha} names pd issue ids: ${ids.join(', ')}\n`);
    if (offending.length > 0) {
      process.stderr.write('Describe the change in words. The pd tip comment links the issue to git.\n');
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Unknown error'}\n`);
    process.exitCode = 1;
  }
}
