// Decides what an ask or a check on an issue holds back and who may resolve it; the stores own the rows and the guarded writes.
import type { Actor } from './agent-gate.ts';

export const itemKinds = ['ask', 'check'] as const;
export type ItemKind = typeof itemKinds[number];
export const itemStates = ['open', 'answered', 'withdrawn', 'met', 'waived'] as const;
export type ItemState = typeof itemStates[number];
export type ResolvedState = Exclude<ItemState, 'open'>;

// The whole rule set, one row per kind: what an open item holds back, and where it may go from open.
// An ask holds the issue out of the ready worklist and holds close; a check holds only close.
// `asker` lets the actor that asked withdraw its own question; `human` is an actor of kind human.
export const itemRules = {
  ask: { holds: ['ready', 'close'], moves: { answered: { by: 'human_not_asker', note: 'optional' }, withdrawn: { by: 'asker_or_human', note: 'required' } } },
  check: { holds: ['close'], moves: { met: { by: 'anyone', note: 'required' }, waived: { by: 'human', note: 'required' } } },
} as const satisfies Record<ItemKind, { holds: readonly ('ready' | 'close')[]; moves: Partial<Record<ResolvedState, { by: string; note: 'required' | 'optional' }>> }>;

export const kindsHolding = (what: 'ready' | 'close'): ItemKind[] => itemKinds.filter(kind => (itemRules[kind].holds as readonly string[]).includes(what));
export const resolvedStatesOf = (kind: ItemKind): ResolvedState[] => Object.keys(itemRules[kind].moves) as ResolvedState[];

export type ObservedItem = { kind: ItemKind; state: ItemState; created_by: string; options: readonly string[] | null;
  answer: string | null; note: string | null; resolved_by: string | null };
export type ItemMove = { to: ResolvedState; answer?: string; note?: string };
/** Where the move comes from. Only the /ui page passes `page`; no operation input can set it. */
export type MoveSurface = 'operation' | 'page';
export type ItemMoveRejection =
  | { code: 'invalid_input'; message: string }
  | { code: 'item_actor_refused'; message: string }
  | { code: 'item_conflict'; message: string };
export type ItemMoveDecision = { accepted: true; unchanged: boolean } | { accepted: false; rejection: ItemMoveRejection };

const refused = (message: string): ItemMoveDecision => ({ accepted: false, rejection: { code: 'item_actor_refused', message } });
const invalid = (message: string): ItemMoveDecision => ({ accepted: false, rejection: { code: 'invalid_input', message } });

/**
 * Decides one move from open. A repeat of the move that already resolved the item, by the same actor with the same answer and note,
 * is accepted as unchanged, so a retry after an uncertain result needs no request ID.
 */
export function decideItemMove(item: ObservedItem, move: ItemMove, actor: Actor, surface: MoveSurface): ItemMoveDecision {
  const rule = (itemRules[item.kind].moves as Partial<Record<ResolvedState, { by: string; note: 'required' | 'optional' }>>)[move.to];
  if (rule === undefined) return invalid(`A ${item.kind} can become ${resolvedStatesOf(item.kind).join(' or ')}, not ${move.to}`);
  if (item.state !== 'open') {
    const repeated = item.state === move.to && item.resolved_by === actor.id && item.answer === (move.answer ?? null) && item.note === (move.note ?? null);
    return repeated ? { accepted: true, unchanged: true } : { accepted: false, rejection: { code: 'item_conflict', message: `The ${item.kind} is already ${item.state}` } };
  }
  if (rule.by === 'human_not_asker') {
    if (actor.kind !== 'human') return refused('Only a human answers an ask');
    // A cloud host that signs in as the owner shares the owner's actor, so only the page, which such a host does not reach, may answer for that actor.
    if (item.created_by === actor.id && surface !== 'page') return refused('The actor that asked cannot answer its own ask here; a person answers it on the /ui issue page');
  }
  if (rule.by === 'human' && actor.kind !== 'human') return refused(`Only a human can ${move.to === 'waived' ? 'waive a check' : `move a ${item.kind} to ${move.to}`}`);
  if (rule.by === 'asker_or_human' && actor.kind !== 'human' && item.created_by !== actor.id) return refused('Only the actor that asked, or a human, withdraws an ask');
  if (move.to === 'answered') {
    if (move.answer === undefined) return invalid('An answer is required');
    if (item.options !== null && !item.options.includes(move.answer)) return invalid(`The answer must be one of the options: ${item.options.join(', ')}`);
  } else if (move.answer !== undefined) return invalid('Only an answer to an ask takes answer');
  if (rule.note === 'required' && move.note === undefined) {
    return invalid(`Moving a ${item.kind} to ${move.to} needs a note: ${move.to === 'met' ? 'the evidence' : 'the reason'}`);
  }
  return { accepted: true, unchanged: false };
}

/** The open items that hold close. */
export function closeHoldingItems<T extends { kind: ItemKind; state: ItemState }>(items: readonly T[]): T[] {
  return items.filter(item => item.state === 'open' && (itemRules[item.kind].holds as readonly string[]).includes('close'));
}
