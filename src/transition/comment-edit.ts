// Decides a comment edit from the observed comment; the store owns the guarded write and the agent claim gate.
import { MAX_COUNTER } from './vocabulary.ts';

export type ObservedComment = { created_by: string; version: number };
export type CommentEdit = { actor: string; expected: number };
export type CommentEditRejection = 'comment_not_found' | 'comment_author_required' | 'comment_conflict' | 'comment_version_exhausted';
export type CommentEditDecision = { accepted: true; version: number } | { accepted: false; code: CommentEditRejection };

// Authorship comes before the version, because a caller who may never edit the comment gains nothing from reading it again.
export function decideCommentEdit(observed: ObservedComment | null, edit: CommentEdit): CommentEditDecision {
  if (observed === null) return { accepted: false, code: 'comment_not_found' };
  if (observed.created_by !== edit.actor) return { accepted: false, code: 'comment_author_required' };
  if (observed.version !== edit.expected) return { accepted: false, code: 'comment_conflict' };
  if (observed.version >= MAX_COUNTER) return { accepted: false, code: 'comment_version_exhausted' };
  return { accepted: true, version: observed.version + 1 };
}
