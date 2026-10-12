// Decides external-resource marks: each mark moves an entry forward once, and only a verified deletion ends it.
import { MAX_COUNTER } from './vocabulary.ts';

export const resourceMarks = ['created', 'deleted', 'verified_deleted'] as const;
export type ResourceMark = typeof resourceMarks[number];
export type ResourceState = 'planned' | 'created' | 'deleted' | 'verified_deleted';
export type ResourceTimes = { created_at: string | null; deleted_at: string | null; verified_deleted_at: string | null };
export type ObservedResource = { state: ResourceState; external_id: string | null };
export type ResourceEdit = { mark?: ResourceMark; external_id?: string };
export type ResourceRejection = 'issue_not_found' | 'revision_conflict' | 'revision_exhausted' | 'entry_not_found' | 'entry_settled' | 'mark_not_forward' | 'external_id_set';
export type ResourceDecision = { accepted: true } | { accepted: false; reason: ResourceRejection };

const forward: Record<ResourceState, readonly ResourceMark[]> = {
  planned: ['created', 'verified_deleted'],
  created: ['deleted'],
  deleted: ['verified_deleted'],
  verified_deleted: [],
};

export function resourceState(times: ResourceTimes): ResourceState {
  if (times.verified_deleted_at !== null) return 'verified_deleted';
  if (times.deleted_at !== null) return 'deleted';
  return times.created_at !== null ? 'created' : 'planned';
}

/** An entry is live, and holds its issue open, until a verified deletion. A planned entry is live too. */
export function resourceIsLive(state: ResourceState): boolean {
  return state !== 'verified_deleted';
}

export function nextResourceMarks(state: ResourceState): readonly ResourceMark[] {
  return forward[state];
}

export function decideResourceAddition(revision: number | null, expectedRevision: number): ResourceDecision {
  if (revision === null) return { accepted: false, reason: 'issue_not_found' };
  if (revision !== expectedRevision) return { accepted: false, reason: 'revision_conflict' };
  if (revision >= MAX_COUNTER) return { accepted: false, reason: 'revision_exhausted' };
  return { accepted: true };
}

export function decideResourceUpdate(revision: number | null, entry: ObservedResource | null, edit: ResourceEdit, expectedRevision: number): ResourceDecision {
  const addition = decideResourceAddition(revision, expectedRevision);
  if (!addition.accepted) return addition;
  if (entry === null) return { accepted: false, reason: 'entry_not_found' };
  if (entry.state === 'verified_deleted') return { accepted: false, reason: 'entry_settled' };
  if (edit.mark !== undefined && !forward[entry.state].includes(edit.mark)) return { accepted: false, reason: 'mark_not_forward' };
  if (edit.external_id !== undefined && entry.external_id !== null && entry.external_id !== edit.external_id) return { accepted: false, reason: 'external_id_set' };
  return { accepted: true };
}
