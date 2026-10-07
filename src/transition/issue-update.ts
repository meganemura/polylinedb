// Decides whether one issue update may commit; SQL plans, row decoding, and error transport stay with the stores.
import { holdsClaim } from './claims.ts';
import type { ClaimProof, ObservedClaim } from './claims.ts';
import { MAX_COUNTER } from './vocabulary.ts';
import type { Field, IssueType, Status } from './vocabulary.ts';

export type FieldChange =
  | { field: 'status'; expected: number; value: Status }
  | { field: 'type'; expected: number; value: IssueType }
  | { field: Exclude<Field, 'status' | 'type'>; expected: number; value: unknown };
export type IssueUpdate = { changes: readonly FieldChange[]; force: boolean; claim_proof?: ClaimProof };
export type ObservedIssue = {
  id: string; versions: Record<Field, number>;
  has_active_blockers: boolean; has_children: boolean;
  claim: ObservedClaim | null; store_incarnation: string;
};
export type FieldConflict = { field: Field; expected: number; actual: number };
export type UpdateRejection =
  | { code: 'conflict'; fields: FieldConflict[] }
  | { code: 'claim_required' }
  | { code: 'dependency_blocked' }
  | { code: 'version_exhausted'; field: Field }
  | { code: 'epic_has_children' };
export type UpdateDecision = { accepted: true } | { accepted: false; rejection: UpdateRejection };

const guardedStatuses: readonly Status[] = ['in_progress', 'closed'];

export function decideIssueUpdate(issue: ObservedIssue, update: IssueUpdate, actor: string, now: number): UpdateDecision {
  const fields = update.changes
    .filter(change => issue.versions[change.field] !== change.expected)
    .map(change => ({ field: change.field, expected: change.expected, actual: issue.versions[change.field] }));
  if (fields.length) return { accepted: false, rejection: { code: 'conflict', fields } };
  if (!ownershipAllowed(issue, update, actor, now)) return { accepted: false, rejection: { code: 'claim_required' } };
  const guarded = update.changes.some(change => change.field === 'status' && guardedStatuses.includes(change.value));
  if (guarded && !update.force && issue.has_active_blockers) return { accepted: false, rejection: { code: 'dependency_blocked' } };
  const exhausted = update.changes.find(change => issue.versions[change.field] >= MAX_COUNTER);
  if (exhausted) return { accepted: false, rejection: { code: 'version_exhausted', field: exhausted.field } };
  if (issue.has_children && update.changes.some(change => change.field === 'type' && change.value !== 'epic')) {
    return { accepted: false, rejection: { code: 'epic_has_children' } };
  }
  return { accepted: true };
}

function ownershipAllowed(issue: ObservedIssue, update: IssueUpdate, actor: string, now: number): boolean {
  if (update.claim_proof) return holdsClaim(issue.claim, issue.store_incarnation, update.claim_proof, issue.id, actor, now);
  return !update.changes.some(change => change.field === 'status') || issue.claim === null;
}
