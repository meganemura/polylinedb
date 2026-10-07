// Admits agent writes only on ready issues they hold; humans keep the cooperative contract, and storage stays with the stores.
import { claimState } from './claims.ts';
import type { ObservedClaim } from './claims.ts';

export const actorKinds = ['human', 'agent'] as const;
export type ActorKind = typeof actorKinds[number];
export type Actor = { id: string; kind: ActorKind };
export const readyLabel = 'ready';
export type GatedWrite = 'claim_acquire' | 'issue_write';
export type GateObservation = { labels: readonly string[]; claim: ObservedClaim | null; store_incarnation: string; now: number };
export type GateDecision = { admitted: true } | { admitted: false; code: 'not_ready' | 'claim_required' };

export function admitAgentWrite(actor: Actor, write: GatedWrite, observed: GateObservation): GateDecision {
  if (actor.kind === 'human') return { admitted: true };
  if (write === 'claim_acquire') return observed.labels.includes(readyLabel) ? { admitted: true } : { admitted: false, code: 'not_ready' };
  const holds = observed.claim !== null && observed.claim.actor === actor.id
    && claimState(observed.claim, observed.store_incarnation, observed.now) === 'active';
  return holds ? { admitted: true } : { admitted: false, code: 'claim_required' };
}
