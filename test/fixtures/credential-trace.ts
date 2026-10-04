// Records synthetic credential child outcomes; credential content and command arguments stay private.
import { appendFileSync } from 'node:fs';
import type { spawn, SpawnOptions } from 'node:child_process';

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  const codes = ['EPIPE', 'ENOENT', 'EAGAIN', 'EMFILE', 'ENFILE', 'EACCES', 'EPERM', 'ECONNRESET'];
  return typeof error.code === 'string' && codes.includes(error.code) ? error.code : 'OTHER';
}

export function traceCredentialChild(start: typeof spawn, executable: string, args: string[], options: SpawnOptions, credentialArgs: string[]) {
  const path = process.env.PD_AUTH_FIXTURE_TRACE;
  if (!path) return start(executable, args, options);
  const category = credentialArgs.includes('find-generic-password') || credentialArgs.includes('lookup') ? 'read'
    : credentialArgs.includes('delete-generic-password') || credentialArgs.includes('clear') ? 'delete'
    : credentialArgs.includes('search') ? 'search' : 'write';
  const started = performance.now();
  const record = (outcome: Record<string, unknown>) => {
    try { appendFileSync(path, JSON.stringify({ category, elapsed_ms: performance.now() - started, ...outcome }) + '\n'); }
    catch { /* Diagnostic storage failure must not change the credential operation. */ }
  };
  let child: ReturnType<typeof spawn>;
  try { child = start(executable, args, options); }
  catch (error) { record({ spawn_error: errorCode(error) }); throw error; }
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdinError: string | null = null;
  let spawnError: string | null = null;
  child.stdout?.on('data', (chunk: Buffer) => { stdoutBytes += chunk.length; });
  child.stderr?.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; });
  child.stdin?.on('error', error => { stdinError = errorCode(error); });
  child.on('error', error => { spawnError = errorCode(error); });
  child.once('close', (status, signal) => record({ status, signal, spawn_error: spawnError,
    stdin_error: stdinError, stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes }));
  return child;
}
