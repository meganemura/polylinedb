// Puts the agent gate into each write batch and names a rejected agent write; humans pass an always-true condition.
import { PolylinedbError } from './errors.ts';
import { claimRow } from './claims.ts';
import type { SqlStatement } from './issues.ts';
import { admitAgentWrite, readyLabel } from '../transition/index.ts';
import type { Actor, GatedWrite } from '../transition/index.ts';

const open: SqlStatement = { sql: '1', params: [] };

export function agentHoldsClaim(issueId: string, actor: Actor): SqlStatement {
  if (actor.kind === 'human') return open;
  return { sql: `EXISTS(SELECT 1 FROM issue_claims AS held JOIN memory_store_identity AS held_store ON held_store.singleton = 1
    WHERE held.issue_id = ? AND held.incarnation = held_store.incarnation AND held.actor = ? AND held.released_at IS NULL AND held.expires_at > unixepoch())`,
  params: [issueId, actor.id] };
}

export function agentMayAcquire(actor: Actor, labelsColumn: string): SqlStatement {
  if (actor.kind === 'human') return open;
  return { sql: `EXISTS(SELECT 1 FROM json_each(${labelsColumn}) WHERE json_each.value = ?)`, params: [readyLabel] };
}

export function heldClaimObservation(issueId: string): SqlStatement {
  return { sql: `SELECT identity.incarnation AS store_incarnation, CAST(unixepoch() AS INTEGER) AS observed_at, claim.* FROM memory_store_identity AS identity
    LEFT JOIN issue_claims AS claim ON claim.issue_id = ? WHERE identity.singleton = 1`, params: [issueId] };
}

export function rejectAgentWrite(actor: Actor, write: GatedWrite, issueId: string, labels: readonly string[], observed: Record<string, unknown> | undefined): void {
  if (actor.kind === 'human') return;
  if (!observed || typeof observed.store_incarnation !== 'string' || typeof observed.observed_at !== 'number') throw new PolylinedbError('storage_error', 'Database omitted the claim observation', 503);
  const decision = admitAgentWrite(actor, write, { labels, claim: observed.generation === null || observed.generation === undefined ? null : claimRow(observed),
    store_incarnation: observed.store_incarnation, now: observed.observed_at });
  if (decision.admitted) return;
  if (decision.code === 'not_ready') throw new PolylinedbError('not_ready', `An agent can claim only an issue with the ${readyLabel} label`, 409, { id: issueId });
  throw new PolylinedbError('claim_required', 'An agent needs its own active claim on this issue before it writes', 409, { id: issueId });
}

export function asActor(caller: string | Actor): Actor {
  return typeof caller === 'string' ? { id: caller, kind: 'human' } : caller;
}
