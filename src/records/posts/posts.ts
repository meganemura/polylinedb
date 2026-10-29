// Owns stars and the posts read. A post is a comment with a handle; comments themselves stay in issues.ts and the DDL in posts-sql.ts.
import { parseIssueId, parseRequestId } from '../store/issue-id.ts';
import { PolylinedbError, requireFields } from '../store/errors.ts';
import { handleSchema, parseHandle, parseVia, shownCommentRow, starrerNames } from '../store/issue-record.ts';
import type { ShownComment, StoredComment } from '../store/issue-record.ts';
import { executeOperation as executeIssue, writeComment } from '../issues/issues.ts';
import type { SqlExecutor } from '../store/sql.ts';
import { issueQueries } from '../store/issue-queries.ts';
import { recordingChanges } from '../store/changes-sql.ts';
import { asActor } from '../claims/agent-gate.ts';
import { decideStarring, starRowChanges } from '../../transition/index.ts';
import type { Actor } from '../../transition/index.ts';

// starrer is the handle when the caller gave one, else the actor, so one persona or one actor stars a post once.
// actor is who wrote the star and the only one who can remove it; the handle grants nothing.
export type Star = { comment_id: string; starrer: string; handle: string | null; actor: string; created_at: string };
type Starring = { id: string; comment_id: string; handle?: string };
export type PostOperation = ({ op: 'star' } & Starring) | ({ op: 'unstar' } & Starring)
  | { op: 'post'; project: string; body: string; handle: string; via?: string; reply_to?: string }
  | { op: 'posts'; project?: string; handle?: string; min_stars: number; since?: string; after?: string; limit: number };
export type StarReceipt = { star: Star; outcome: 'added' | 'already_present' | 'removed' } | { star: null; outcome: 'already_absent' };
export type PostPage = { posts: ShownComment[]; next_cursor: string | null };
export type PostResult = StarReceipt | PostPage | { comment: StoredComment };

const invalidStore = (): never => { throw new PolylinedbError('invalid_store', 'Stored star is invalid', 500); };
const invalid = (message: string): never => { throw new PolylinedbError('invalid_input', message); };
const utf8 = (value: string) => new TextEncoder().encode(value).length;
function name(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || utf8(value) > 256 || /\p{Cc}/u.test(value)) return invalid(`${label} must be 1 through 256 UTF-8 bytes without control characters`);
  return value;
}

export function starRow(row: Record<string, unknown>): Star {
  try {
    const handle = row.handle === null ? null : parseHandle(row.handle);
    const actor = name(row.actor, 'actor');
    if (row.starrer !== (handle ?? actor) || typeof row.created_at !== 'string' || row.created_at.length === 0) return invalidStore();
    return { comment_id: parseRequestId(row.comment_id), starrer: handle ?? actor, handle, actor, created_at: row.created_at };
  } catch { return invalidStore(); }
}

const idSchema = { type: 'string', pattern: String.raw`^[a-z][a-z0-9]{0,15}-[1-9][0-9]*(\.[1-9][0-9]*){0,7}$` };
const commentIdSchema = { type: 'string', format: 'uuid', description: 'The comment ID that show or posts returns.' };
const objectSchema = (properties: Record<string, unknown>, required: readonly string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const projectSchema = { type: 'string', minLength: 1, maxLength: 256 };
export const postSchemas = {
  post: objectSchema({ project: { ...projectSchema, description: "The project the post belongs to. It goes to that project's timeline, which needs no issue and no claim." },
    body: { type: 'string', minLength: 1, maxLength: 65536, description: 'One lesson, in one or two lines.' },
    handle: { ...handleSchema, description: 'The persona you speak as, such as builder, tester, scout, or coordinator. Attribution only: it grants nothing.' },
    via: { type: 'string', minLength: 1, maxLength: 128, description: 'What produced this post, such as a host, a model, and a place. Attribution only.' },
    reply_to: { type: 'string', format: 'uuid', description: 'The ID of a timeline post this one answers.' } }, ['project', 'body', 'handle']),
  star: objectSchema({ id: idSchema, comment_id: commentIdSchema,
    handle: { ...handleSchema, description: 'Star as this persona instead of as your actor, such as tester. One persona or one actor stars a post once. It grants nothing.' } }, ['id', 'comment_id']),
  unstar: objectSchema({ id: idSchema, comment_id: commentIdSchema,
    handle: { ...handleSchema, description: 'Remove the star you gave as this persona; without it, the star you gave as your actor.' } }, ['id', 'comment_id']),
  posts: objectSchema({ project: { ...projectSchema, description: 'Keep only the posts on issues of this project. Without it, every project.' },
    handle: { ...handleSchema, description: 'Keep only the posts of this persona.' },
    min_stars: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0, description: 'Keep only posts with at least this many stars.' },
    since: { type: 'string', description: 'Keep only posts created at or after this time: an ISO 8601 instant with a time zone, or a date YYYY-MM-DD read as midnight UTC.' },
    after: { type: 'string', format: 'uuid', description: 'next_cursor from the previous page.' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }, []),
};

function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return invalid('operation must be a plain object');
  return value as Record<string, unknown>;
}
function validated<T>(parse: () => T): T {
  try { return parse(); } catch (error) { return invalid(error instanceof Error ? error.message : 'Invalid identifier'); }
}
function count(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid(`${label} must be an integer from ${minimum} through ${maximum}`);
  return value;
}
const day = /^(\d{4})-(\d{2})-(\d{2})$/;
const instant = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
// Date.parse moves February 30 into March, so the calendar date is checked on its own.
function calendarDate(year: string, month: string, date: string): boolean {
  const at = new Date(Date.UTC(Number(year), Number(month) - 1, Number(date)));
  return at.getUTCFullYear() === Number(year) && at.getUTCMonth() === Number(month) - 1 && at.getUTCDate() === Number(date);
}
/** Normalizes since to the form comments store, so the read compares text with text. */
export function parseSince(value: unknown): string {
  const match = typeof value === 'string' ? day.exec(value) ?? instant.exec(value) : null;
  const time = typeof value === 'string' && match !== null && calendarDate(match[1] ?? '', match[2] ?? '', match[3] ?? '') ? Date.parse(day.test(value) ? `${value}T00:00:00Z` : value) : Number.NaN;
  if (!Number.isFinite(time)) return invalid('since must be an ISO 8601 instant with a time zone, such as 2026-10-24T09:00:00Z, or a date such as 2026-10-24');
  return new Date(time).toISOString();
}

export function parsePostOperation(value: unknown): PostOperation {
  const input = plain(value);
  const op = input.op;
  if (op !== 'star' && op !== 'unstar' && op !== 'post' && op !== 'posts') return invalid('Unknown post operation');
  const schema = postSchemas[op];
  requireFields(input, ['op', ...Object.keys(schema.properties)], ['op', ...schema.required]);
  const handle = input.handle === undefined ? {} : { handle: parseHandle(input.handle) };
  if (op === 'post') {
    if (typeof input.body !== 'string' || input.body.length === 0 || utf8(input.body) > 65536) return invalid('body must be 1 through 65536 UTF-8 bytes');
    return { op, project: name(input.project, 'project'), body: input.body, handle: parseHandle(input.handle),
      ...(input.via === undefined ? {} : { via: parseVia(input.via) }),
      ...(input.reply_to === undefined ? {} : { reply_to: validated(() => parseRequestId(input.reply_to, 'reply_to')) }) };
  }
  if (op === 'posts') return { op, ...(input.project === undefined ? {} : { project: name(input.project, 'project') }), ...handle,
    min_stars: input.min_stars === undefined ? 0 : count(input.min_stars, 'min_stars', 0, Number.MAX_SAFE_INTEGER),
    ...(input.since === undefined ? {} : { since: parseSince(input.since) }),
    ...(input.after === undefined ? {} : { after: validated(() => parseRequestId(input.after, 'after')) }),
    limit: input.limit === undefined ? 50 : count(input.limit, 'limit', 1, 100) };
  return { op, id: validated(() => parseIssueId(input.id)), comment_id: validated(() => parseRequestId(input.comment_id, 'comment_id')), ...handle };
}

function rowsAt(results: readonly { rows: readonly Record<string, unknown>[] }[], index: number): readonly Record<string, unknown>[] {
  const result = results[index];
  if (!result) throw new PolylinedbError('storage_error', 'Database omitted a star result', 503);
  return result.rows;
}

// One guarded write decides the star: an INSERT that does nothing on a repeated starrer, or a DELETE of the caller's own star.
// Neither needs a claim, because a star changes no issue field; the service still refuses a reader, because both are writes.
// The trigger records an event only for a row that appears or disappears, so a repeated star or a missing unstar records none.
async function star(db: SqlExecutor, operation: Extract<PostOperation, { op: 'star' | 'unstar' }>, caller: Actor): Promise<StarReceipt> {
  const actor = name(caller.id, 'actor');
  const { id, comment_id } = operation;
  const starrer = operation.handle ?? actor;
  const onIssue = 'EXISTS(SELECT 1 FROM comments WHERE id = ? AND issue_id = ?)';
  const write = operation.op === 'star'
    ? { sql: `INSERT INTO stars(comment_id, starrer, handle, actor, created_at) SELECT ?, ?, ?, ?, ? WHERE ${onIssue}
      ON CONFLICT(comment_id, starrer) DO NOTHING RETURNING *`, params: [comment_id, starrer, operation.handle ?? null, actor, new Date().toISOString(), comment_id, id] }
    : { sql: `DELETE FROM stars WHERE comment_id = ? AND starrer = ? AND actor = ? AND ${onIssue} RETURNING *`, params: [comment_id, starrer, actor, comment_id, id] };
  const result = await recordingChanges(db, actor).batch([write,
    { sql: `SELECT EXISTS(SELECT 1 FROM issues WHERE id = ?) AS issue, ${onIssue} AS comment`, params: [id, comment_id, id] },
    { sql: 'SELECT * FROM stars WHERE comment_id = ? AND starrer = ?', params: [comment_id, starrer] }]);
  const written = rowsAt(result, 0)[0];
  if (written) return { star: starRow(written), outcome: operation.op === 'star' ? 'added' : 'removed' };
  const thread = rowsAt(result, 1)[0];
  const stored = rowsAt(result, 2)[0];
  const current = stored === undefined ? null : starRow(stored);
  const decision = decideStarring({ issue: thread?.issue === 1, comment: thread?.comment === 1, star: current },
    operation.op === 'star' ? { kind: 'star' } : { kind: 'unstar', actor });
  if (!decision.accepted) {
    switch (decision.code) {
      case 'not_found': throw new PolylinedbError('not_found', 'Issue was not found', 404, { id });
      case 'comment_not_found': throw new PolylinedbError('comment_not_found', 'Comment was not found on this issue', 404, { id, comment_id });
      case 'star_owner_required': throw new PolylinedbError('star_owner_required', 'Only the actor that gave a star can remove it', 403, { id, comment_id, starrer });
      default: { const unreachable: never = decision.code; return unreachable; }
    }
  }
  if (starRowChanges(decision.outcome)) throw new PolylinedbError('storage_error', 'The database rejected a star without a matching condition', 503);
  if (decision.outcome === 'already_present' && current !== null) return { star: current, outcome: 'already_present' };
  if (decision.outcome === 'already_absent') return { star: null, outcome: 'already_absent' };
  throw new PolylinedbError('storage_error', 'Database omitted a star result', 503);
}

// Newest first by (created_at, id), so a page boundary between two posts of the same millisecond still keeps each post on one page.
async function posts(db: SqlExecutor, operation: Extract<PostOperation, { op: 'posts' }>): Promise<PostPage> {
  const rows = await db.reads.all(issueQueries.posts, { project: operation.project ?? null, handle: operation.handle ?? null, since: operation.since ?? null,
    min_stars: operation.min_stars, after: operation.after ?? null, limit: operation.limit + 1 });
  const found = rows.map(row => shownCommentRow({ ...row, starrers: starrerNames(row.starrers_json) }));
  if (found.some(post => post.handle === null)) throw new PolylinedbError('invalid_store', 'Stored post is invalid', 500);
  const page = found.slice(0, operation.limit);
  return { posts: page, next_cursor: found.length > operation.limit ? page.at(-1)?.id ?? null : null };
}

export type PostHandle = { handle: string; posts: number };
/** The personas that have posted, most posts first, so a reader can pick one instead of typing it. */
export async function postHandles(db: SqlExecutor, limit: number): Promise<PostHandle[]> {
  return (await db.reads.all(issueQueries.postHandles, { limit })).map(row => {
    if (typeof row.posts !== 'number' || !Number.isSafeInteger(row.posts) || row.posts < 1) throw new PolylinedbError('invalid_store', 'Stored post count is invalid', 500);
    return { handle: parseHandle(row.handle), posts: row.posts };
  });
}

/** The project of each issue a page of posts names, read in one query so the all-projects list can label every post. */
export async function postProjects(db: SqlExecutor, issueIds: readonly string[]): Promise<Map<string, string>> {
  if (issueIds.length === 0) return new Map();
  const rows = await db.reads.all(issueQueries.postProjects, { ids: [...new Set(issueIds)] });
  return new Map(rows.map(row => [parseIssueId(row.id), name(row.project, 'project')]));
}

export const timelineLabel = 'timeline';
// The request ID is a name-based UUID of the project, so the first posts of two callers create the same timeline issue at most once.
async function timelineRequestId(project: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`polylinedb timeline\n${project}`)));
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x80;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// A project's timeline is an ordinary issue with the timeline label, created closed so it never enters a work lane.
// It takes the prefix and tool of the project's newest issue, so a project with no issue yet has nowhere to post.
async function timelineIssue(db: SqlExecutor, project: string, caller: Actor): Promise<string> {
  const found = async () => { const row = (await db.reads.all(issueQueries.timelineIssue, { project }))[0]; return row === undefined ? null : parseIssueId(row.id); };
  const existing = await found();
  if (existing !== null) return existing;
  const source = (await db.reads.all(issueQueries.projectNewestIssue, { project }))[0];
  if (source === undefined) throw new PolylinedbError('not_found', 'The project has no issue yet, so it has no timeline to post to', 404, { project });
  const prefix = parseIssueId(source.id).split('-')[0] ?? invalidStore();
  try {
    const created = await executeIssue(db, { op: 'create', prefix, request_id: await timelineRequestId(project), tool: name(source.tool, 'tool'), project,
      body: `Timeline\n\nPosts on ${project} that belong to no single issue. The post operation writes here; keep it closed.`,
      status: 'closed', type: 'chore', priority: 4, labels: [timelineLabel] }, caller);
    if ('issue' in created) return created.issue.id;
  } catch (error) {
    // Another caller created it first under the same request ID, so read the issue it made.
    if (!(error instanceof PolylinedbError && error.code === 'request_conflict')) throw error;
  }
  return await found() ?? invalidStore();
}

async function post(db: SqlExecutor, operation: Extract<PostOperation, { op: 'post' }>, caller: Actor): Promise<{ comment: StoredComment }> {
  const id = await timelineIssue(db, operation.project, caller);
  const { op: _, project: __, ...voice } = operation;
  return writeComment(db, { op: 'comment', id, ...voice }, caller, false);
}

export async function executePostOperation(db: SqlExecutor, operation: PostOperation, by: string | Actor): Promise<PostResult> {
  if (operation.op === 'posts') return posts(db, operation);
  if (operation.op === 'post') return post(db, operation, asActor(by));
  return star(db, operation, asActor(by));
}
