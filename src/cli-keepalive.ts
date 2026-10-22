// Renews one claim lease through the ordinary claim_show and claim_renew operations while a child
// process or a watched process runs. It adds no operation, so released Workers and local stores serve it.
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { PolylinedbError, parseOperation } from './records/index.ts';
import type { ClaimInspection, Operation, OperationResult } from './records/index.ts';

export const defaultMaxDurationSeconds = 7200;
export const maximumMaxDurationSeconds = 28800;
// Distinct from the usage, not-found and conflict exit codes of the other commands.
export const keepaliveExitCodes: Readonly<Record<string, number>> = { claim_lost: 5, keepalive_max_duration: 6 };

export type ClaimProofInput = { issue_id: string; incarnation: string; session_id: string; generation: number };
export type KeepaliveTarget = { kind: 'command'; argv: readonly string[] } | { kind: 'pid'; pid: number };
export type KeepaliveOptions = {
  execute: (operation: Operation) => Promise<OperationResult>;
  proof: unknown;
  ttl: number;
  maxDurationSeconds: number;
  target: KeepaliveTarget;
  killOnLoss: boolean;
};

// Renewal is due one third of the TTL before the deadline, measured on the database clock from the
// observation. Time already spent in the call counts against the delay, so a slow call renews sooner.
export function renewalDelayMs(input: { observedAt: number; expiresAt: number; ttl: number; elapsedMs: number }): number {
  const lead = Math.ceil(input.ttl / 3);
  const windowMs = Math.max(0, (input.expiresAt - input.observedAt - lead) * 1000);
  const capMs = Math.max(0, (input.ttl - lead) * 1000);
  const elapsed = Math.max(0, input.elapsedMs);
  return Math.max(0, Math.min(windowMs, capMs) - elapsed);
}

function inspectionOf(result: OperationResult): ClaimInspection {
  if ('claim' in result && !('claim_receipt' in result)) return result.claim as ClaimInspection;
  throw new PolylinedbError('internal_error', 'Claim inspection returned an unexpected result shape', 500);
}

function lostError(proof: ClaimProofInput, inspection: ClaimInspection): PolylinedbError {
  return new PolylinedbError('claim_lost', `The claim on ${proof.issue_id} is no longer held by this proof`, 409, {
    id: proof.issue_id, state: inspection.state, generation: inspection.lease?.generation ?? null, expires_at: inspection.lease?.expires_at ?? null });
}

function owns(inspection: ClaimInspection, proof: ClaimProofInput): boolean {
  const lease = inspection.lease;
  return inspection.state === 'active' && lease !== null && inspection.store_incarnation === proof.incarnation
    && lease.session_id === proof.session_id && lease.generation === proof.generation;
}

function releasedByUs(inspection: ClaimInspection, proof: ClaimProofInput): boolean {
  const lease = inspection.lease;
  return inspection.state === 'released' && lease !== null && lease.session_id === proof.session_id && lease.generation === proof.generation;
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export const killGraceMs = 5000;
const releaseConfirmMs = 5000;

// --kill-on-loss promises the command is gone when claim_lost is reported, and an unreaped child can
// linger as a zombie once this process exits. So wait for the exit, escalating to SIGKILL after a grace period.
async function terminate(child: ReturnType<typeof spawn>, exited: Promise<Outcome>): Promise<void> {
  const gone = exited.then(() => undefined, () => undefined);
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    child.kill(signal);
    const timer = new AbortController();
    const result = await Promise.race([gone.then(() => 'gone' as const), delay(killGraceMs, 'timeout' as const, { signal: timer.signal })]);
    timer.abort();
    if (result === 'gone') return;
  }
  child.unref();
}

type Outcome = { kind: 'exited'; code: number } | { kind: 'released' } | { kind: 'lost'; error: PolylinedbError } | { kind: 'max_duration' };

// Resolves the process exit code; throws PolylinedbError for loss, the duration bound, or a failed store call.
export async function runKeepalive(options: KeepaliveOptions): Promise<number> {
  const { execute, ttl } = options;
  const probe = parseOperation({ op: 'claim_renew', claim_proof: options.proof, expected_revision: 1, request_id: randomUUID(), ttl });
  if (probe.op !== 'claim_renew') throw new Error('Unexpected operation');
  const proof = probe.claim_proof as ClaimProofInput;

  const shown = await execute(parseOperation({ op: 'show', id: proof.issue_id }));
  if (!('issue' in shown) || !Array.isArray((shown as { issue: { labels?: unknown } }).issue.labels)) {
    throw new PolylinedbError('internal_error', 'Issue read returned an unexpected result shape', 500);
  }
  if ((shown as { issue: { labels: string[] } }).issue.labels.includes('main-lock')) {
    throw new PolylinedbError('main_lock_refused', `${proof.issue_id} is labeled main-lock; keep that claim short and renew it by hand`, 409, { id: proof.issue_id });
  }

  const first = inspectionOf(await execute({ op: 'claim_show', issue_id: proof.issue_id }));
  if (!owns(first, proof)) throw lostError(proof, first);

  const controller = new AbortController();
  const startedAt = Date.now();
  let child: ReturnType<typeof spawn> | undefined;
  let exited: Promise<Outcome>;
  if (options.target.kind === 'command') {
    const [command, ...args] = options.target.argv;
    const spawned = spawn(command, args, { stdio: 'inherit' });
    child = spawned;
    exited = new Promise<Outcome>((resolve, reject) => {
      spawned.once('error', error => reject(new PolylinedbError('keepalive_spawn_failed', `Cannot start ${command}: ${error.message}`, 400)));
      spawned.once('close', (code, signal) => resolve({ kind: 'exited', code: code ?? 128 + (signal === null ? 0 : constants.signals[signal] ?? 0) }));
    });
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { spawned.kill(signal); });
  } else {
    const pid = options.target.pid;
    exited = (async (): Promise<Outcome> => {
      while (pidAlive(pid)) await delay(500, undefined, { signal: controller.signal });
      return { kind: 'exited', code: 0 };
    })();
  }
  const watchdog = delay(options.maxDurationSeconds * 1000, undefined, { signal: controller.signal }).then((): Outcome => ({ kind: 'max_duration' }));

  const watchRelease = async (): Promise<Outcome | undefined> => {
    const started = Date.now();
    for (;;) {
      const inspection = inspectionOf(await execute({ op: 'claim_show', issue_id: proof.issue_id }));
      if (!releasedByUs(inspection, proof)) {
        if (!owns(inspection, proof) || inspection.lease === null) return { kind: 'lost', error: lostError(proof, inspection) };
        return undefined;
      }
      if (Date.now() - started >= releaseConfirmMs) return { kind: 'released' };
      await delay(250, undefined, { signal: controller.signal });
    }
  };

  const cycle = async (): Promise<Outcome> => {
    let failures = 0;
    for (;;) {
      const began = Date.now();
      try {
        const inspection = inspectionOf(await execute({ op: 'claim_show', issue_id: proof.issue_id }));
        if (releasedByUs(inspection, proof)) {
          const watched = await watchRelease();
          if (watched !== undefined) return watched;
          continue;
        }
        if (!owns(inspection, proof) || inspection.lease === null) {
          return { kind: 'lost', error: lostError(proof, inspection) };
        }
        const renewed = await execute({ op: 'claim_renew', claim_proof: probe.claim_proof, expected_revision: inspection.lease.revision, request_id: randomUUID(), ttl });
        if (!('claim_receipt' in renewed)) throw new PolylinedbError('internal_error', 'Claim renewal returned an unexpected result shape', 500);
        failures = 0;
        const receipt = renewed.claim_receipt;
        await delay(renewalDelayMs({ observedAt: receipt.changed_at, expiresAt: receipt.expires_at, ttl, elapsedMs: Date.now() - began }), undefined, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        // A revision conflict from another renewal by this session, or a transient failure, is rechecked from claim_show.
        if (++failures >= 3) throw error;
        await delay(1000, undefined, { signal: controller.signal });
      }
    }
  };
  const looping: Promise<Outcome> = cycle();

  let outcome: Outcome;
  try { outcome = await Promise.race([exited, watchdog, looping]); }
  finally { controller.abort(); }
  looping.catch(() => undefined);
  watchdog.catch(() => undefined);
  exited.catch(() => undefined);

  if (outcome.kind === 'exited') return outcome.code;
  if (outcome.kind === 'released') {
    child?.unref();
    return 0;
  }
  if (options.killOnLoss && child !== undefined && child.exitCode === null && child.signalCode === null) {
    await terminate(child, exited);
  } else {
    // A running command that is spared must not keep this process alive.
    child?.unref();
  }
  if (outcome.kind === 'lost') throw outcome.error;
  throw new PolylinedbError('keepalive_max_duration', `Stopped renewing ${proof.issue_id} after ${options.maxDurationSeconds} seconds; the lease ends at its current deadline`, 409, { id: proof.issue_id, max_duration: options.maxDurationSeconds, elapsed: Math.round((Date.now() - startedAt) / 1000) });
}
