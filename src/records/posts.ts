// Owns stars on posts; comments themselves stay in issues.ts and the DDL in posts-sql.ts.
import { parseRequestId } from './issue-id.ts';
import { PolylinedbError } from './errors.ts';
import { parseHandle } from './issues.ts';

// starrer is the handle when the caller gave one, else the actor, so one persona or one actor stars a post once.
// actor is who wrote the star and the only one who can remove it; the handle grants nothing.
export type Star = { comment_id: string; starrer: string; handle: string | null; actor: string; created_at: string };

const invalidStore = (): never => { throw new PolylinedbError('invalid_store', 'Stored star is invalid', 500); };
function name(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || new TextEncoder().encode(value).length > 256 || /\p{Cc}/u.test(value)) return invalidStore();
  return value;
}

export function starRow(row: Record<string, unknown>): Star {
  try {
    const handle = row.handle === null ? null : parseHandle(row.handle);
    const actor = name(row.actor);
    if (row.starrer !== (handle ?? actor) || typeof row.created_at !== 'string' || row.created_at.length === 0) return invalidStore();
    return { comment_id: parseRequestId(row.comment_id), starrer: handle ?? actor, handle, actor, created_at: row.created_at };
  } catch { return invalidStore(); }
}
