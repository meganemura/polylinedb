// Owns issue numbering syntax and ordering; counters and request storage belong to SQL.
export function parsePrefix(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9]{0,15}$/.test(value)) throw new Error('prefix must contain 1–16 lowercase letters or digits, starting with a letter');
  return value;
}
export function parseRequestId(value: unknown, label = 'request_id'): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error(`${label} must be a lowercase UUID`);
  return value;
}
export function parseIssueId(value: unknown, label = 'id'): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9]{0,15}-[1-9][0-9]*(\.[1-9][0-9]*){0,7}$/.test(value)) throw new Error(`Invalid ${label}`);
  const numbers = value.slice(value.indexOf('-') + 1).split('.');
  if (numbers.some(number => !Number.isSafeInteger(Number(number)))) throw new Error('Issue number exceeds the safe integer range');
  return value;
}
export function issueSortKey(value: string): string {
  const id = parseIssueId(value);
  const separator = id.indexOf('-');
  return id.slice(0, separator + 1) + id.slice(separator + 1).split('.').map(number => number.padStart(16, '0')).join('.');
}
