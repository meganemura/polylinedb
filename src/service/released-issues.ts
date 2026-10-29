// Shapes /v1/operations bodies for released CLIs, whose decoders reject any issue key they do not know.
// MCP output keeps the full issue; agents read it directly and need no fixed key set.
// A client that sends `polylinedb-issue-fields: closure` decodes the closure, so its bodies keep both keys.
// A client that sends `items` decodes asks and checks. For any other client the body keeps the released shape: show loses `items`,
// claim_acquire loses `open_asks`, and items_open loses its details, because released clients reject details on an error code they do not know.
const closureKeys = ['closed_at', 'closed_by'];
const isIssue = (value: object) => Object.hasOwn(value, 'versions') && closureKeys.some(key => Object.hasOwn(value, key));

export function withoutClosure(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutClosure);
  if (value === null || typeof value !== 'object') return value;
  const issue = isIssue(value);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !(issue && closureKeys.includes(key)))
    .map(([key, entry]) => [key, withoutClosure(entry)]));
}

export const issueFieldsHeader = 'polylinedb-issue-fields';

function withoutItems(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if ('comments' in value && 'items' in value) { const { items: _, ...rest } = value as Record<string, unknown>; return rest; }
  if ('claim_receipt' in value && 'open_asks' in value) { const { open_asks: _, ...rest } = value as Record<string, unknown>; return rest; }
  if (!('error' in value)) return value;
  const error = value.error;
  if (error === null || typeof error !== 'object' || !('code' in error) || error.code !== 'items_open') return value;
  const { details: _, ...rest } = error as Record<string, unknown>;
  return { ...value, error: rest };
}

const requestedFields = (request: Request) => (request.headers.get(issueFieldsHeader) ?? '').split(',').map(token => token.trim().toLowerCase());

export function issueFieldsFor(request: Request): (value: unknown) => unknown {
  const requested = requestedFields(request);
  const closure = requested.includes('closure') ? (value: unknown) => value : withoutClosure;
  return requested.includes('items') ? closure : value => withoutItems(closure(value));
}

// A released client's owner-wait decoder requires an owner label on every wait, so it reads the waits that labels make.
export function operationFor<T extends { op: string }>(request: Request, operation: T): T {
  return operation.op === 'dependency_owner_waits' && !requestedFields(request).includes('items') ? { ...operation, labels_only: true } : operation;
}
