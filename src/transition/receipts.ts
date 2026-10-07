// Decides how a repeated request ID resolves against its stored receipt; receipt storage stays with the stores.
export type StoredRequest = { actor?: unknown; payload?: unknown };
export type ReplayDecision = 'replay' | 'request_conflict';

export function decideReplay(stored: StoredRequest, actor: string, payload: string): ReplayDecision {
  return stored.actor === actor && stored.payload === payload ? 'replay' : 'request_conflict';
}
