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

type Process = { pid: number; ppid: number; stat: string; cpu: string; rss: string; command: string };

// A descendant with almost no RSS and no CPU has not finished exec yet; one that runs points at a real hang.
function processTree(pid: number | undefined): { cpu: string; descendants: string } {
  let rows: Process[];
  try {
    rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,stat=,time=,rss=,comm='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(line => {
      const [pid, ppid, stat, cpu, rss, ...command] = line.trim().split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), stat, cpu, rss, command: command.join(' ') };
    });
  } catch { return { cpu: 'unavailable', descendants: 'unavailable' }; }
  const descendants: Process[] = [];
  const parents = [pid];
  for (let index = 0; index < parents.length; index++) {
    for (const row of rows) if (row.ppid === parents[index]) { descendants.push(row); parents.push(row.pid); }
  }
  return { cpu: rows.find(row => row.pid === pid)?.cpu ?? 'unavailable',
    descendants: descendants.map(row => `${row.pid} ${row.stat} CPU ${row.cpu} RSS ${row.rss} KiB ${row.command}`).join('; ') || 'none' };
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
    let deadline = spawned + limits.startMs;
    // A timer that fires minutes late means this test process was paused too, not only the child.
    const stop = () => {
      const now = performance.now();
      const tree = processTree(child.pid);
      const timing = `timer ${Math.round(now - deadline)} ms late`;
      failure = started === undefined
        ? `${label} did not start within ${limits.startMs} ms: pid ${child.pid}, child CPU ${tree.cpu}, ${timing}`
        : `${label} did not exit within ${limits.runMs} ms after it started: pid ${child.pid}, child CPU ${tree.cpu}, `
          + `started ${Math.round(started - spawned)} ms after spawn, ${Math.round(now - spawned)} ms in total, ${timing}, descendants: ${tree.descendants}`;
      child.kill('SIGKILL');
    };
    let timer = setTimeout(stop, limits.startMs);
    (child.stdio[3] as Readable).once('data', () => {
      started = performance.now();
      deadline = started + limits.runMs;
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
