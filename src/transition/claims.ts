// Decides lease ownership from an observed claim; receipts, replay, and storage stay with the stores.
import { MAX_COUNTER } from './vocabulary.ts';

export type ClaimProof = { issue_id: string; incarnation: string; session_id: string; generation: number };
export type ObservedClaim = { incarnation: string; actor: string; session_id: string; generation: number; revision: number; expires_at: number; released_at: number | null };
export type ClaimState = 'never_claimed' | 'active' | 'released' | 'expired' | 'invalidated';
export type ClaimCommand =
  | { op: 'claim_acquire'; incarnation: string }
  | { op: 'claim_renew'; claim_proof: ClaimProof; expected_revision: number }
  | { op: 'claim_report'; claim_proof: ClaimProof }
  | { op: 'claim_release'; claim_proof: ClaimProof; expected_revision: number; expired_noop?: true };
export type ClaimRejection = 'stale_incarnation' | 'already_active' | 'counter_exhausted' | 'revision_conflict' | 'proof_rejected';
export type ClaimDecision = { accepted: true } | { accepted: false; reason: ClaimRejection };

export function claimState(claim: ObservedClaim | null, storeIncarnation: string, now: number): ClaimState {
  if (claim === null) return 'never_claimed';
  if (claim.incarnation !== storeIncarnation) return 'invalidated';
  if (claim.released_at !== null) return 'released';
  return claim.expires_at <= now ? 'expired' : 'active';
}

export function holdsClaim(claim: ObservedClaim | null, storeIncarnation: string, proof: ClaimProof, issueId: string, actor: string, now: number): boolean {
  return claim !== null && proof.issue_id === issueId && proof.incarnation === storeIncarnation
    && claimState(claim, storeIncarnation, now) === 'active' && claim.incarnation === proof.incarnation
    && claim.actor === actor && claim.session_id === proof.session_id && claim.generation === proof.generation;
}

export function ownsExpiredLease(claim: ObservedClaim | null, storeIncarnation: string, proof: ClaimProof, issueId: string, actor: string, now: number): boolean {
  return claim !== null && proof.issue_id === issueId && claimState(claim, storeIncarnation, now) === 'expired'
    && claim.incarnation === proof.incarnation && claim.actor === actor
    && claim.session_id === proof.session_id && claim.generation === proof.generation;
}

export function decideClaimMutation(claim: ObservedClaim | null, storeIncarnation: string, command: ClaimCommand, actor: string, now: number): ClaimDecision {
  if (command.op === 'claim_acquire') {
    if (command.incarnation !== storeIncarnation) return { accepted: false, reason: 'stale_incarnation' };
    if (claimState(claim, storeIncarnation, now) === 'active') return { accepted: false, reason: 'already_active' };
    if (claim !== null && (claim.generation >= MAX_COUNTER || claim.revision >= MAX_COUNTER)) return { accepted: false, reason: 'counter_exhausted' };
    return { accepted: true };
  }
  // A report names its lease by the proof alone: the newest line wins, so there is no revision to conflict on.
  if (command.op === 'claim_report') {
    if (claim !== null && claim.revision >= MAX_COUNTER) return { accepted: false, reason: 'counter_exhausted' };
    return holdsClaim(claim, storeIncarnation, command.claim_proof, command.claim_proof.issue_id, actor, now) ? { accepted: true } : { accepted: false, reason: 'proof_rejected' };
  }
  if (command.op === 'claim_release' && command.expired_noop === true && ownsExpiredLease(claim, storeIncarnation, command.claim_proof, command.claim_proof.issue_id, actor, now)) return { accepted: true };
  if (claim === null || claim.revision !== command.expected_revision) return { accepted: false, reason: 'revision_conflict' };
  if (claim.revision >= MAX_COUNTER) return { accepted: false, reason: 'counter_exhausted' };
  if (!holdsClaim(claim, storeIncarnation, command.claim_proof, command.claim_proof.issue_id, actor, now)) return { accepted: false, reason: 'proof_rejected' };
  return { accepted: true };
}

// A holder reports one line about what it is doing. The newest line replaces the one before it, so the holder reports
// progress without growing the comment thread, and a renewal proves only that the lease is held.
export const activityKinds = ['working', 'blocked', 'error', 'done'] as const;
export type ActivityKind = typeof activityKinds[number];
export type ReportedActivity = { kind: ActivityKind; text: string; at: number };
export const runStates = ['working', 'waiting', 'errored', 'finishing', 'quiet'] as const;
export type RunState = typeof runStates[number];
export type Run = { state: RunState; quiet_after: number; last: ReportedActivity | null };
/** Ten minutes: a working holder that says nothing for longer is quiet, even while keepalive renews its lease. */
const QUIET_AFTER_SECONDS = 600;
const runOf: Record<ActivityKind, RunState> = { working: 'working', blocked: 'waiting', error: 'errored', done: 'finishing' };
export type ReportedLease = { acquired_at: number; expires_at: number; released_at: number | null };
/**
 * Decides a lease's run state from its newest report. Only `working` decays to quiet; the other kinds already ask for someone.
 * A lease that ended keeps the state it had when it ended, so an error stays visible after the lease is gone.
 */
export function runState(lease: ReportedLease, last: ReportedActivity | null, now: number): Run {
  const state = runOf[last?.kind ?? 'working'];
  const asOf = Math.min(now, lease.released_at ?? lease.expires_at);
  const quiet = state === 'working' && asOf - (last?.at ?? lease.acquired_at) >= QUIET_AFTER_SECONDS;
  return { state: quiet ? 'quiet' : state, quiet_after: QUIET_AFTER_SECONDS, last };
}
