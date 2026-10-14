// Runs the pd command from source, as `npm start` does, against a store in
// a scratch directory selected with POLYLINEDB_DATA_DIR.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

export interface PdResult {
  exitCode: number;
  output: Record<string, any>;
}

export function pd(args: string[], store: { workDir: string; dataDir: string }): PdResult {
  // Every write names its actor with --actor, so a POLYLINEDB_ACTOR from
  // the person's own shell must not decide one.
  const { POLYLINEDB_ACTOR: _ignored, ...env } = process.env;
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: store.workDir,
    encoding: 'utf8',
    env: { ...env, POLYLINEDB_DATA_DIR: store.dataDir },
  });
  if (result.error) throw result.error;
  return { exitCode: result.status ?? 1, output: JSON.parse(result.stdout || result.stderr) };
}

export const rewriteResult = {
  exitCode: 'pd\'s exit code: 0 on success, 4 on a conflict',
  body: 'the body this actor tried to write',
  output: 'pd\'s JSON output: the updated issue, or the error',
};

export function rewriteBody(
  actor: string,
  { workDir, dataDir, id, bodyVersion }: { workDir: string; dataDir: string; id: string; bodyVersion: number },
): { exitCode: number; body: string; output: Record<string, unknown> } {
  const body = `Handle empty input, as ${actor} decided`;
  const { exitCode, output } = pd(['--actor', actor, 'update', id, '--body', body, '--expect', `body=${bodyVersion}`], { workDir, dataDir });
  return { exitCode, body, output };
}
