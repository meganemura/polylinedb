// Owns the stored shape of an issue's asks and checks and the open-item conditions that issue writes and the queue handoff share.
// The item operations live in records/items; this layer stays below claims so the handoff can apply the same close rule as close.
import { PolylinedbError } from './errors.ts';
import { parseIssueId } from './issue-id.ts';
import type { SqlExecutor, SqlStatement } from './sql.ts';
import { closeHoldingItems, itemKinds, itemStates, kindsHolding } from '../../transition/index.ts';
import type { ItemKind, ItemState } from '../../transition/index.ts';

export type Item = { n: number; kind: ItemKind; text: string; options: string[] | null; recommended: string | null; state: ItemState;
  answer: string | null; note: string | null; created_at: string; created_by: string; resolved_at: string | null; resolved_by: string | null };
/** An item as it was asked or added, before any answer: what an issue's new lane reads on claim_acquire. */
export type OpenAsk = { n: number; text: string; options: string[] | null; recommended: string | null };

const invalidStore = (): never => { throw new PolylinedbError('invalid_store', 'Stored item is invalid', 500); };
const text = (value: unknown): string => typeof value === 'string' && value.length > 0 ? value : invalidStore();
const optionalText = (value: unknown): string | null => value === null ? null : text(value);

export function itemRow(row: Record<string, unknown>): Item & { issue_id: string } {
  const kind = itemKinds.find(candidate => candidate === row.kind) ?? invalidStore();
  const state = itemStates.find(candidate => candidate === row.state) ?? invalidStore();
  if (typeof row.n !== 'number' || !Number.isSafeInteger(row.n) || row.n < 1) return invalidStore();
  let options: string[] | null = null;
  if (row.options_json !== null) {
    const parsed: unknown = JSON.parse(text(row.options_json));
    if (!Array.isArray(parsed) || parsed.some(option => typeof option !== 'string')) return invalidStore();
    options = parsed as string[];
  }
  let issue_id: string;
  try { issue_id = parseIssueId(row.issue_id); } catch { return invalidStore(); }
  return { issue_id, n: row.n, kind, text: text(row.text), options, recommended: optionalText(row.recommended), state, answer: optionalText(row.answer), note: optionalText(row.note),
    created_at: text(row.created_at), created_by: text(row.created_by), resolved_at: optionalText(row.resolved_at), resolved_by: optionalText(row.resolved_by) };
}

/** True while the issue has an open item that holds it back from `what`: ready, or close and the queue handoff. */
export const openItemExists = (issue: string, what: 'ready' | 'close') =>
  `EXISTS(SELECT 1 FROM issue_items WHERE issue_items.issue_id = ${issue} AND issue_items.state = 'open' AND issue_items.kind IN (${kindsHolding(what).map(kind => `'${kind}'`).join(',')}))`;

export const issueItemsRead = (issueId: string): SqlStatement => ({ sql: 'SELECT * FROM issue_items WHERE issue_id = ? ORDER BY n', params: [issueId] });

export async function readIssueItems(db: SqlExecutor, issueIds: readonly string[]): Promise<Map<string, Item[]>> {
  const found = new Map<string, Item[]>(issueIds.map(id => [id, []]));
  if (issueIds.length === 0) return found;
  const [result] = await db.batch([{ sql: `SELECT * FROM issue_items WHERE issue_id IN (${issueIds.map(() => '?').join(',')}) ORDER BY issue_id, n`, params: [...issueIds] }]);
  for (const row of result?.rows ?? []) {
    const { issue_id, ...item } = itemRow(row);
    found.get(issue_id)?.push(item);
  }
  return found;
}

/** The next step for one item that holds close, as the CLI command and the MCP call that take it. */
function nextStep(issueId: string, item: Item): string {
  if (item.kind === 'check') return `check #${item.n} ${JSON.stringify(item.text)}: meet it with evidence (pd item meet ${issueId} ${item.n} 'EVIDENCE', or item_resolve with n ${item.n}, to met, and note), or ask a person to waive it`;
  return `ask #${item.n} ${JSON.stringify(item.text)}: wait for a person to answer it (pd wait --issue ${issueId} --kind answered), or withdraw it (pd item withdraw ${issueId} ${item.n} 'REASON', or item_resolve with n ${item.n}, to withdrawn, and note)`;
}

/**
 * The refusal for a close or a handoff while an ask is open or a check is unmet. The message names every such item and its next command,
 * so a caller fixes it in one round trip. The details carry the same items for a caller that reads them.
 */
export function itemsOpenError(issueId: string, items: readonly Item[]): PolylinedbError | null {
  const open = closeHoldingItems(items);
  if (open.length === 0) return null;
  return new PolylinedbError('items_open', `The issue has ${open.length} open item${open.length === 1 ? '' : 's'} that hold close: ${open.map(item => nextStep(issueId, item)).join('; ')}.`, 409,
    { id: issueId, open_items: open.map(({ n, kind, text: itemText }) => ({ n, kind, text: itemText })) });
}

export async function refuseOpenItems(db: SqlExecutor, issueId: string): Promise<void> {
  const error = itemsOpenError(issueId, (await readIssueItems(db, [issueId])).get(issueId) ?? []);
  if (error) throw error;
}

/** Open asks on issues that are not closed, grouped by issue, at most `limit` asks. Lanes read this beside the attention read, in one wave. */
export async function openAsksByIssue(db: SqlExecutor, limit: number): Promise<Map<string, OpenAsk[]>> {
  const [result] = await db.batch([{ sql: `SELECT issue_items.* FROM issue_items JOIN issues ON issues.id = issue_items.issue_id
    WHERE issue_items.kind = 'ask' AND issue_items.state = 'open' AND issues.status <> 'closed' ORDER BY issue_items.created_at, issue_items.issue_id, issue_items.n LIMIT ?`, params: [limit] }]);
  const found = new Map<string, OpenAsk[]>();
  for (const row of result?.rows ?? []) {
    const { issue_id, n, text: askText, options, recommended } = itemRow(row);
    found.set(issue_id, [...(found.get(issue_id) ?? []), { n, text: askText, options, recommended }]);
  }
  return found;
}

export const openAsksOf = (items: readonly Item[]): OpenAsk[] => items.filter(item => item.kind === 'ask' && item.state === 'open')
  .map(({ n, text: askText, options, recommended }) => ({ n, text: askText, options, recommended }));

/** The stored columns of an item, as a snapshot importer inserts them. */
export function storedItemColumns(item: Item & { issue_id: string; request_id: string }): Record<string, string | number | null> {
  return { issue_id: item.issue_id, n: item.n, kind: item.kind, text: item.text, options_json: item.options === null ? null : JSON.stringify(item.options),
    recommended: item.recommended, state: item.state, answer: item.answer, note: item.note, request_id: item.request_id,
    created_at: item.created_at, created_by: item.created_by, resolved_at: item.resolved_at, resolved_by: item.resolved_by };
}
