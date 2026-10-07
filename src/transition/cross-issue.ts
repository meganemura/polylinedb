// Classifies creation and prerequisite edits from rows that the store observed in the same transaction; counters and the cycle trigger stay in SQL.
import { MAX_COUNTER } from './vocabulary.ts';
import type { IssueType } from './vocabulary.ts';

export type ObservedParent = { type: IssueType } | null;
export type CreationDecision = { accepted: true } | { accepted: false; reason: 'parent_not_found' | 'parent_not_epic' };
export type ObservedPrerequisites = { dependent_revision: number | null; blocker_exists: boolean };
export type PrerequisiteRejection = 'dependent_not_found' | 'blocker_not_found' | 'revision_conflict' | 'revision_exhausted';
export type PrerequisiteDecision = { accepted: true } | { accepted: false; reason: PrerequisiteRejection };

export function decideCreation(parentId: string | undefined, parent: ObservedParent): CreationDecision {
  if (parentId === undefined) return { accepted: true };
  if (parent === null) return { accepted: false, reason: 'parent_not_found' };
  return parent.type === 'epic' ? { accepted: true } : { accepted: false, reason: 'parent_not_epic' };
}

export function decidePrerequisiteEdit(observed: ObservedPrerequisites, expectedRevision: number): PrerequisiteDecision {
  if (observed.dependent_revision === null) return { accepted: false, reason: 'dependent_not_found' };
  if (!observed.blocker_exists) return { accepted: false, reason: 'blocker_not_found' };
  if (observed.dependent_revision !== expectedRevision) return { accepted: false, reason: 'revision_conflict' };
  if (observed.dependent_revision >= MAX_COUNTER) return { accepted: false, reason: 'revision_exhausted' };
  return { accepted: true };
}
