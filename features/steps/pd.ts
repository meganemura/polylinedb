// Runs the pd command from source, as `npm start` does, against a store in
// a scratch directory selected with POLYLINEDB_DATA_DIR.
import { runCommand } from 'nukadoko';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

export interface PdResult {
  exitCode: number;
  output: Record<string, any>;
}

export async function pd(args: string[], store: { workDir: string; dataDir: string }): Promise<PdResult> {
  // Every write names its actor with --actor, so a POLYLINEDB_ACTOR from
  // the person's own shell must not decide one.
  const { POLYLINEDB_ACTOR: _ignored, ...env } = process.env;
  const result = await runCommand(process.execPath, [CLI, ...args], {
    cwd: store.workDir,
    env: { ...env, POLYLINEDB_DATA_DIR: store.dataDir },
  });
  return { exitCode: result.exitCode ?? 1, output: JSON.parse(result.stdout || result.stderr) };
}

// docs/operations.md: "Exit codes are 0 for success, 2 for invalid input, 3
// for missing issues, 4 for conflicts, and 1 for other failures." A Then
// claims the word a sentence uses, so a step names the code by this table.
export const exitMeanings = ['success', 'failure', 'invalid input', 'missing issue', 'conflict'] as const;
export type ExitMeaning = (typeof exitMeanings)[number];

export function exitMeaning(exitCode: number): ExitMeaning {
  return exitMeanings[exitCode] ?? 'failure';
}

export const rewriteResult = {
  exitCode: 'pd\'s exit code: 0 on success, 4 on a conflict',
  exit: 'pd\'s exit code by its meaning in docs/operations.md: success, conflict, and so on',
  body: 'the body this actor tried to write',
  output: 'pd\'s JSON output: the updated issue, or the error',
};

export async function rewriteBody(
  actor: string,
  { workDir, dataDir, id, bodyVersion }: { workDir: string; dataDir: string; id: string; bodyVersion: number },
): Promise<{ exitCode: number; exit: ExitMeaning; body: string; output: Record<string, unknown> }> {
  const body = `Handle empty input, as ${actor} decided`;
  const { exitCode, output } = await pd(['--actor', actor, 'update', id, '--body', body, '--expect', `body=${bodyVersion}`], { workDir, dataDir });
  return { exitCode, exit: exitMeaning(exitCode), body, output };
}
