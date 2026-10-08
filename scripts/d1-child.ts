// Bounds the cf and pd children of the D1 operator scripts and describes their failures; it does not read their output.
import type { SpawnSyncReturns } from 'node:child_process';

// Tests raise the limit: on a loaded host, exec of a node child can wait past the operator default.
export function childLimitMs(defaultMs: number): number {
  const value = process.env.POLYLINEDB_D1_CHILD_LIMIT_MS;
  if (value === undefined) return defaultMs;
  if (!/^[1-9][0-9]{0,8}$/.test(value)) throw new Error('POLYLINEDB_D1_CHILD_LIMIT_MS must be a positive number of milliseconds');
  return Number(value);
}

export function childFailure(result: SpawnSyncReturns<string>, limitMs: number): string | undefined {
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ETIMEDOUT') return `did not exit within ${limitMs} ms (ETIMEDOUT)`;
  if (result.error) return `failed (${code ?? result.error.message})`;
  if (result.signal) return `stopped by ${result.signal}`;
  if (result.status !== 0) return `exited with status ${result.status}`;
  return undefined;
}

// cf diagnostics can carry account IDs, database IDs, and tokens. Every long identifier-shaped run is
// redacted, including UUIDs and hex IDs, so the excerpt keeps error words such as ECONNRESET.
export function stderrExcerpt(stderr: string | null): string {
  const text = (stderr ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[A-Za-z0-9_+/=-]{20,}/g, '[redacted]')
    .replace(/\p{Cc}+/gu, ' ').trim();
  if (!text) return 'none';
  return text.length > 300 ? '...' + text.slice(-300) : text;
}
