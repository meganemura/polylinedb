// Decides lease ownership from an observed claim; receipts, replay, and storage stay with the stores.
import { MAX_COUNTER } from './vocabulary.ts';

export type ClaimProof = { issue_id: string; incarnation: string; session_id: string; generation: number };
export type ObservedClaim = { incarnation: string; actor: string; session_id: string; generation: number; revision: number; expires_at: number; released_at: number | null };
export type ClaimState = 'never_claimed' | 'active' | 'released' | 'expired' | 'invalidated';
export type ClaimCommand =
  | { op: 'claim_acquire'; incarnation: string }
  | { op: 'claim_renew' | 'claim_release'; claim_proof: ClaimProof; expected_revision: number };
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

export function decideClaimMutation(claim: ObservedClaim | null, storeIncarnation: string, command: ClaimCommand, actor: string, now: number): ClaimDecision {
  if (command.op === 'claim_acquire') {
    if (command.incarnation !== storeIncarnation) return { accepted: false, reason: 'stale_incarnation' };
    if (claimState(claim, storeIncarnation, now) === 'active') return { accepted: false, reason: 'already_active' };
    if (claim !== null && (claim.generation >= MAX_COUNTER || claim.revision >= MAX_COUNTER)) return { accepted: false, reason: 'counter_exhausted' };
    return { accepted: true };
  }
  if (claim === null || claim.revision !== command.expected_revision) return { accepted: false, reason: 'revision_conflict' };
  if (claim.revision >= MAX_COUNTER) return { accepted: false, reason: 'counter_exhausted' };
  if (!holdsClaim(claim, storeIncarnation, command.claim_proof, command.claim_proof.issue_id, actor, now)) return { accepted: false, reason: 'proof_rejected' };
  return { accepted: true };
}
