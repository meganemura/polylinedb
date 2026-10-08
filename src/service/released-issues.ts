// Shapes /v1/operations bodies for released CLIs, whose decoders reject any issue key they do not know.
// MCP output keeps the full issue; agents read it directly and need no fixed key set.
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
