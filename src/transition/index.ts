// Exposes the pure issue and claim decisions that local and cloud stores share.
export { statuses, issueTypes, fields, MAX_COUNTER } from './vocabulary.ts';
export type { Status, IssueType, Field } from './vocabulary.ts';
export { claimState, holdsClaim, decideClaimMutation } from './claims.ts';
export type { ClaimProof, ObservedClaim, ClaimState, ClaimCommand, ClaimRejection, ClaimDecision } from './claims.ts';
export { decideIssueUpdate } from './issue-update.ts';
export type { FieldChange, IssueUpdate, ObservedIssue, FieldConflict, UpdateRejection, UpdateDecision } from './issue-update.ts';
export { decideReplay } from './receipts.ts';
export type { StoredRequest, ReplayDecision } from './receipts.ts';
export { decideCreation, decidePrerequisiteEdit } from './cross-issue.ts';
export type { ObservedParent, CreationDecision, ObservedPrerequisites, PrerequisiteRejection, PrerequisiteDecision } from './cross-issue.ts';
export { actorKinds, readyLabel, admitAgentWrite } from './agent-gate.ts';
export type { ActorKind, Actor, GatedWrite, GateObservation, GateDecision } from './agent-gate.ts';
