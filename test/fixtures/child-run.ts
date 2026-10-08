// Runs a test child and stops it when it hangs; it does not judge the child's output.
// On a loaded macOS host, exec of a node binary can wait tens of seconds before any child code runs,
// while exec of /bin/sh or git stays fast. So the run limit starts at the child's start signal on fd 3,
// which test/fixtures/child-started.ts sends, and a separate start limit covers the exec wait.
import { execFileSync, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

export type ChildLimits = { startMs: number; runMs: number };
export type ChildResult = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

// The start limit only keeps the suite from waiting forever on a host that never runs the child.
export const childLimits: ChildLimits = { startMs: 300_000, runMs: 60_000 };
export const childStarted = new URL('./child-started.ts', import.meta.url).pathname;

function cpuTime(pid: number | undefined): string {
  try { return execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim() || 'unavailable'; }
  catch { return 'unavailable'; }
}

export function runChild(label: string, executable: string, args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string; limits?: ChildLimits }): Promise<ChildResult> {
  const limits = options.limits ?? childLimits;
  return new Promise((resolve, reject) => {
    const spawned = performance.now();
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let started: number | undefined;
    let failure: string | undefined;
    const stop = () => {
      const elapsed = Math.round(performance.now() - spawned);
      failure = started === undefined
        ? `${label} did not start within ${limits.startMs} ms: pid ${child.pid}, child CPU ${cpuTime(child.pid)}`
        : `${label} did not exit within ${limits.runMs} ms after it started: pid ${child.pid}, child CPU ${cpuTime(child.pid)}, `
          + `started ${Math.round(started - spawned)} ms after spawn, ${elapsed} ms in total`;
      child.kill('SIGKILL');
    };
    let timer = setTimeout(stop, limits.startMs);
    (child.stdio[3] as Readable).once('data', () => {
      started = performance.now();
      clearTimeout(timer);
      timer = setTimeout(stop, limits.runMs);
    });
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      if (failure !== undefined) reject(new Error(failure));
      else resolve({ status, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    // A child may exit without reading its input; spawnSync also ignored that write failure.
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });
}
