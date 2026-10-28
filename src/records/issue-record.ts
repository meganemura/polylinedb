// Decodes issue and comment rows, and parses the field values they hold. Issue commands and their SQL stay in issues.ts.
import { parseIssueId, parseRequestId } from './issue-id.ts';
import { PolylinedbError } from './errors.ts';
import { fields, issueTypes, statuses } from '../transition/index.ts';

export type Status = typeof statuses[number];
export type IssueType = typeof issueTypes[number];
export type Field = typeof fields[number];
export type Values = {
  tool: string; project: string; body: string; status: Status; type: IssueType;
  priority: number; labels: string[];
};
// Both fields describe the current closed state: set on entering closed, cleared on leaving it.
// A transport that does not report closure leaves both fields out; null means the store holds no close record.
export type Closure = { closed_at: string | null; closed_by: string | null };
export type Issue = Values & { id: string; versions: Record<Field, number>;
  created_at: string; created_by: string; updated_at: string; updated_by: string } & Partial<Closure>;
export type StoredIssue = Issue & Closure;
// version counts edits from 1; updated_at and updated_by name the last edit and stay null until one. An edit keeps no earlier body.
// A transport from before comment edits leaves all three fields out.
export type CommentEdits = { version: number; updated_at: string | null; updated_by: string | null };
// A post is a comment with a voice. handle names the persona that speaks, via names what produced this one post, and reply_to names the comment it answers on the same issue.
// All three are attribution the writer declares and never authorize anything; created_by stays the authenticated actor. A transport from before posts leaves all three out.
export type CommentPost = { handle: string | null; via: string | null; reply_to: string | null };
// stars counts every star on the comment; starrers names the oldest ones, at most 20. Only reads that show comments carry them.
export type CommentStars = { stars: number; starrers: string[] };
type CommentText = { id: string; issue_id: string; body: string; created_at: string; created_by: string };
export type Comment = CommentText & Partial<CommentEdits> & Partial<CommentPost> & Partial<CommentStars>;
export type StoredComment = CommentText & CommentEdits & CommentPost;
export type ShownComment = StoredComment & CommentStars;
export const invalid = (message: string): never => { throw new PolylinedbError('invalid_input', message); };
export function object(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid(`${context} must be an object`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return invalid(`${context} must be a plain object`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, maximum = 65536): string {
  if (typeof value !== 'string' || value.trim().length === 0) return invalid(`${name} must be a nonempty string`);
  if (new TextEncoder().encode(value).length > maximum) return invalid(`${name} exceeds ${maximum} UTF-8 bytes`);
  if (value.includes('\u0000')) return invalid(`${name} must not contain NUL`);
  return value;
}
export function name(value: unknown, label: string): string {
  const result = text(value, label, 256);
  if (/\p{Cc}/u.test(result)) return invalid(`${label} must not contain control characters`);
  return result;
}
export function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return invalid(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}
export function enumeration<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  if (typeof value !== 'string') return invalid(`${label} must be one of ${allowed.join(', ')}`);
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) return invalid(`${label} must be one of ${allowed.join(', ')}`);
  return match;
}
export function validated(parser: (value: unknown) => string, value: unknown): string {
  try { return parser(value); } catch (error) { return invalid(error instanceof Error ? error.message : 'Invalid identifier'); }
}
export function id(value: unknown, _label = 'id'): string { return validated(parseIssueId, value); }
/** The handle rule: 1 to 64 lowercase ASCII letters, digits, '.', '_' or '-', starting with a letter or digit. handleSql states it in SQL. */
export function parseHandle(value: unknown, label = 'handle'): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) return invalid(`${label} must be 1 to 64 lowercase ASCII letters, digits, '.', '_' or '-', starting with a letter or digit`);
  return value;
}
/** via is free text of at most 128 UTF-8 bytes without control characters, such as a host, a model, and a place. */
export function parseVia(value: unknown): string {
  const result = text(value, 'via', 128);
  if (/\p{Cc}/u.test(result)) return invalid('via must not contain control characters');
  return result;
}
export function labels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64) return invalid('labels must be an array of at most 64 names');
  return [...new Set(value.map((label) => name(label, 'label')))].sort();
}

export const handleSchema = { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$',
  description: 'A persona you speak as, such as builder, tester, scout, or coordinator, chosen by whoever starts the session. Attribution only: it grants nothing, and created_by stays your actor.' };
export function parseClosure(row: Record<string, unknown>, status: Status): Closure {
  if (row.closed_at === null && row.closed_by === null) return { closed_at: null, closed_by: null };
  if (status !== 'closed') return invalid('closure requires status closed');
  return { closed_at: text(row.closed_at, 'closed_at'), closed_by: name(row.closed_by, 'closed_by') };
}
export function issueRow(row: Record<string, unknown>): Issue {
  try {
    const versions = Object.fromEntries(fields.map((field) => [field, integer(row[`${field}_v`], `${field} version`, 1, Number.MAX_SAFE_INTEGER)])) as Record<Field, number>;
    if (typeof row.labels_json !== 'string') throw new Error('labels_json is not text');
    const issue: Issue = { id: id(row.id), tool: name(row.tool, 'tool'), project: name(row.project, 'project'), body: text(row.body, 'body'),
      status: enumeration(row.status, 'status', statuses), type: enumeration(row.type, 'type', issueTypes),
      priority: integer(row.priority, 'priority', 0, 4), labels: labels(JSON.parse(row.labels_json)), versions,
      created_at: text(row.created_at, 'created_at'), created_by: name(row.created_by, 'created_by'),
      updated_at: text(row.updated_at, 'updated_at'), updated_by: name(row.updated_by, 'updated_by') };
    if (!Object.hasOwn(row, 'closed_at') && !Object.hasOwn(row, 'closed_by')) return issue;
    return { ...issue, ...parseClosure(row, issue.status) };
  } catch (error) {
    throw new PolylinedbError('invalid_store', `Stored issue is invalid: ${error instanceof Error ? error.message : 'invalid row'}`, 500);
  }
}
const editKeys = ['version', 'updated_at', 'updated_by'] as const;
const postKeys = ['handle', 'via', 'reply_to'] as const;
const starKeys = ['stars', 'starrers'] as const;
/** Counts the keys of one group that a row holds; a group comes whole or not at all, because an older transport omits it whole. */
function group(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = keys.filter(key => Object.hasOwn(row, key)).length;
  if (present !== 0 && present !== keys.length) return invalid(`${keys.join(', ')} come together`);
  return present === keys.length;
}
function commentPost(row: Record<string, unknown>, id: string): CommentPost {
  const reply_to = row.reply_to === null ? null : validated(parseRequestId, row.reply_to);
  if (reply_to === id) return invalid('a comment does not reply to itself');
  return { handle: row.handle === null ? null : parseHandle(row.handle), via: row.via === null ? null : parseVia(row.via), reply_to };
}
function commentStars(row: Record<string, unknown>): CommentStars {
  const stars = integer(row.stars, 'stars', 0, Number.MAX_SAFE_INTEGER);
  if (!Array.isArray(row.starrers) || row.starrers.length > Math.min(stars, 20) || (stars > 0 && row.starrers.length === 0)) return invalid('starrers lists the oldest stars, at most 20');
  const starrers = row.starrers.map(starrer => name(starrer, 'starrer'));
  if (new Set(starrers).size !== starrers.length) return invalid('starrers are distinct');
  return { stars, starrers };
}
function commentEdits(row: Record<string, unknown>): CommentEdits {
  const version = integer(row.version, 'version', 1, Number.MAX_SAFE_INTEGER);
  if (version === 1) {
    if (row.updated_at !== null || row.updated_by !== null) return invalid('an unedited comment has no editor');
    return { version, updated_at: null, updated_by: null };
  }
  return { version, updated_at: text(row.updated_at, 'updated_at'), updated_by: name(row.updated_by, 'updated_by') };
}
/** Reads a comment with or without each group of later fields: the edit fields, the post fields, and the star fields each come whole or not at all. */
export function commentRow(row: Record<string, unknown>): Comment {
  try {
    const comment: Comment = { id: validated(parseRequestId, row.id), issue_id: id(row.issue_id), body: text(row.body, 'body'),
      created_at: text(row.created_at, 'created_at'), created_by: name(row.created_by, 'created_by') };
    const edits = group(row, editKeys) ? commentEdits(row) : {};
    // Only the author edits a comment, so any other editor means the row did not come from comment_edit.
    if ('updated_by' in edits && edits.updated_by !== null && edits.updated_by !== comment.created_by) return invalid('the editor is the author');
    return { ...comment, ...edits, ...(group(row, postKeys) ? commentPost(row, comment.id) : {}), ...(group(row, starKeys) ? commentStars(row) : {}) };
  } catch { throw new PolylinedbError('invalid_store', 'Stored comment is invalid', 500); }
}
/** Reads a comment as a read that shows comments returns it: every group, with its stars. */
export function shownCommentRow(row: Record<string, unknown>): ShownComment {
  const { stars, starrers } = commentRow(row);
  if (stars === undefined || starrers === undefined) throw new PolylinedbError('invalid_store', 'Stored comment is invalid', 500);
  return { ...storedCommentRow(row), stars, starrers };
}
/** Decodes the JSON array of starrer names that a read built with json_group_array. */
export function starrerNames(value: unknown): unknown {
  if (typeof value !== 'string') throw new PolylinedbError('invalid_store', 'Stored comment is invalid', 500);
  try { return JSON.parse(value); } catch { throw new PolylinedbError('invalid_store', 'Stored comment is invalid', 500); }
}
/** Reads a comment row as the store holds it: with its edit and post fields, and without stars, which live in their own table. */
export function storedCommentRow(row: Record<string, unknown>): StoredComment {
  const { stars: _stars, starrers: _starrers, ...comment } = commentRow(row);
  if (comment.version === undefined || comment.updated_at === undefined || comment.updated_by === undefined
    || comment.handle === undefined || comment.via === undefined || comment.reply_to === undefined) throw new PolylinedbError('invalid_store', 'Stored comment is invalid', 500);
  return { ...comment, version: comment.version, updated_at: comment.updated_at, updated_by: comment.updated_by, handle: comment.handle, via: comment.via, reply_to: comment.reply_to };
}
