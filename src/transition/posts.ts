// Decides replies and stars from what a write batch observed; the store owns the guarded writes and the reads after them.

/** replyTarget is null when the comment answers nothing, else whether the named comment is on the same issue. */
export type ObservedReply = { issue: boolean; replyTarget: boolean | null };
export type ReplyRejection = 'not_found' | 'reply_target_not_found';
export type ReplyDecision = { accepted: true } | { accepted: false; code: ReplyRejection };

// The issue comes first, so a reply on a missing issue names the issue and not a target it could never hold.
export function decideReply(observed: ObservedReply): ReplyDecision {
  if (!observed.issue) return { accepted: false, code: 'not_found' };
  if (observed.replyTarget === false) return { accepted: false, code: 'reply_target_not_found' };
  return { accepted: true };
}

/** comment is whether the starred comment is on the named issue; star is the row of the same starrer, or null. */
export type ObservedStarring = { issue: boolean; comment: boolean; star: { actor: string } | null };
export type Starring = { kind: 'star' } | { kind: 'unstar'; actor: string };
export type StarOutcome = 'added' | 'already_present' | 'removed' | 'already_absent';
export type StarRejection = 'not_found' | 'comment_not_found' | 'star_owner_required';
export type StarDecision = { accepted: true; outcome: StarOutcome } | { accepted: false; code: StarRejection };

// Both directions are idempotent: a repeated star returns the star that exists, and a missing star is already absent.
// A handle grants nothing, so only the actor that wrote a star removes it, even when another actor speaks as the same persona.
export function decideStarring(observed: ObservedStarring, starring: Starring): StarDecision {
  if (!observed.issue) return { accepted: false, code: 'not_found' };
  if (!observed.comment) return { accepted: false, code: 'comment_not_found' };
  if (starring.kind === 'star') return { accepted: true, outcome: observed.star === null ? 'added' : 'already_present' };
  if (observed.star === null) return { accepted: true, outcome: 'already_absent' };
  if (observed.star.actor !== starring.actor) return { accepted: false, code: 'star_owner_required' };
  return { accepted: true, outcome: 'removed' };
}

/** Whether the outcome adds or removes a row, which is exactly when the feed records an event. */
export function starRowChanges(outcome: StarOutcome): boolean {
  return outcome === 'added' || outcome === 'removed';
}
