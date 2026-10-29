// Decides whether one issue update may commit; SQL plans, row decoding, and error transport stay with the stores.
import { holdsClaim } from './claims.ts';
import type { ClaimProof, ObservedClaim } from './claims.ts';
import { MAX_COUNTER } from './vocabulary.ts';
import type { Field, IssueType, Status } from './vocabulary.ts';

export type FieldChange =
  | { field: 'status'; expected: number; value: Status }
  | { field: 'type'; expected: number; value: IssueType }
  | { field: Exclude<Field, 'status' | 'type'>; expected: number; value: unknown };
// resources_acknowledged is true when the caller gave a reason to close while external resources are still live.
export type IssueUpdate = { changes: readonly FieldChange[]; force: boolean; resources_acknowledged: boolean; claim_proof?: ClaimProof };
export type ObservedIssue = {
  id: string; status: Status; type: IssueType; versions: Record<Field, number>;
  has_active_blockers: boolean; has_children: boolean; has_live_resources: boolean; has_open_items: boolean;
  claim: ObservedClaim | null; store_incarnation: string;
};
export type FieldConflict = { field: Field; expected: number; actual: number };
export type UpdateRejection =
  | { code: 'conflict'; fields: FieldConflict[] }
  | { code: 'claim_required' }
  | { code: 'dependency_blocked' }
  | { code: 'items_open' }
  | { code: 'resources_remaining' }
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
  const closing = update.changes.some(change => change.field === 'status' && change.value === 'closed');
  // force with its reason answers for open asks and unmet checks as it does for prerequisites; live resources need their own reason.
  if (closing && !update.force && issue.has_open_items) return { accepted: false, rejection: { code: 'items_open' } };
  if (closing && !update.resources_acknowledged && issue.has_live_resources) return { accepted: false, rejection: { code: 'resources_remaining' } };
  const exhausted = update.changes.find(change => issue.versions[change.field] >= MAX_COUNTER);
  if (exhausted) return { accepted: false, rejection: { code: 'version_exhausted', field: exhausted.field } };
  if (issue.has_children && update.changes.some(change => change.field === 'type' && change.value !== 'epic')) {
    return { accepted: false, rejection: { code: 'epic_has_children' } };
  }
  return { accepted: true };
}

// An epic tracks its children's work, so it may be in progress with no claim of its own.
export function startedWorkNeedsClaim(status: Status, type: IssueType): boolean {
  return status === 'in_progress' && type !== 'epic';
}

function ownershipAllowed(issue: ObservedIssue, update: IssueUpdate, actor: string, now: number): boolean {
  if (update.claim_proof) return holdsClaim(issue.claim, issue.store_incarnation, update.claim_proof, issue.id, actor, now);
  const status = update.changes.find((change): change is Extract<FieldChange, { field: 'status' }> => change.field === 'status')?.value ?? issue.status;
  const type = update.changes.find((change): change is Extract<FieldChange, { field: 'type' }> => change.field === 'type')?.value ?? issue.type;
  const decidesState = update.changes.some(change => change.field === 'status' || change.field === 'type');
  if (decidesState && startedWorkNeedsClaim(status, type)) return false;
  return !update.changes.some(change => change.field === 'status') || issue.claim === null;
}
