// Runs the local workerd D1 integration files concurrently. Each file starts its own Miniflare and temporary state.
// Output is printed per file in list order once all files finish, and any failure fails the run.
import './test-node-runtime.mjs';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

// The slowest files come first, so the pool does not finish on one long file.
export const d1Files = [
  'test/transition-differential-d1.integration.ts',
  'test/d1-snapshot.integration.ts',
  'test/d1-restored-addition.integration.ts',
  'test/changes-d1.integration.ts',
  'test/comment-edit-d1.integration.ts',
  'test/posts-d1.integration.ts',
  'test/d1-relay.integration.ts',
  'test/gate-races-d1.integration.ts',
  'test/memory-freshness-d1.integration.ts',
  'test/claims-sql.integration.ts',
  'test/d1.integration.ts',
  'test/dependencies-d1.integration.ts',
  'test/land-order-d1.integration.ts',
  'test/resources-d1.integration.ts',
];

type Outcome = { file: string; status: number | null; output: string; seconds: number };

function runFile(file: string): Promise<Outcome> {
  return new Promise(resolve => {
    const started = performance.now();
    const child = spawn(process.execPath, ['--import', new URL('./test-node-runtime.mjs', import.meta.url).href, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.on('error', error => { output += `${error.message}\n`; });
    child.on('close', status => resolve({ file, status, output, seconds: (performance.now() - started) / 1000 }));
  });
}

export async function runAll(files: string[], limit: number): Promise<Outcome[]> {
  const outcomes: Outcome[] = new Array(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const index = next++;
      outcomes[index] = await runFile(files[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, files.length) }, worker));
  return outcomes;
}

if (import.meta.main) {
  const outcomes = await runAll(d1Files, availableParallelism());
  for (const outcome of outcomes) {
    process.stdout.write(`== ${outcome.file} (${outcome.seconds.toFixed(1)} s, exit ${String(outcome.status)})\n${outcome.output}`);
  }
  const failed = outcomes.filter(outcome => outcome.status !== 0);
  if (failed.length > 0) {
    process.stderr.write(`Failed: ${failed.map(outcome => outcome.file).join(', ')}\n`);
    process.exitCode = 1;
  }
}
