// Owns domain error codes, HTTP status metadata, and invalid-input wording; transport serialization belongs to adapters.
// Input errors name fields and expected types but never echo a caller's values.
export class PolylinedbError extends Error {
  code: string;
  status: number;
  details?: unknown;
  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'PolylinedbError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// A broken client can serialize a secret as a key, so only identifier-shaped names are echoed.
const echoedNames = 10;
const echoedNameBytes = 64;
const echoedName = (key: string) => /^[A-Za-z0-9_.[\]-]+$/.test(key) ? key.slice(0, echoedNameBytes) : '<invalid name>';
const listed = (kind: string, names: readonly string[], shown: number) => {
  const hidden = names.length - shown;
  return `${kind} field${names.length === 1 ? '' : 's'}: ${[names.slice(0, shown).join(', '), hidden > 0 ? `(+${hidden} more)` : ''].filter(Boolean).join(' ')}`;
};
export function requireFields(input: Record<string, unknown>, allowed: readonly string[], required: readonly string[], at?: string): void {
  const path = (key: string) => at === undefined ? echoedName(key) : `${at}.${echoedName(key)}`;
  const unexpected = Object.keys(input).filter(key => !allowed.includes(key)).map(path);
  const missing = required.filter(key => !Object.hasOwn(input, key)).map(path);
  const missingShown = Math.min(missing.length, echoedNames);
  const problems = [...(unexpected.length ? [listed('unexpected', unexpected, echoedNames - missingShown)] : []), ...(missing.length ? [listed('missing', missing, missingShown)] : [])];
  if (!problems.length) return;
  const message = problems.join('; ');
  throw new PolylinedbError('invalid_input', message[0].toUpperCase() + message.slice(1));
}
export function expectedType(path: string, type: string): never {
  throw new PolylinedbError('invalid_input', `${path}: expected ${type}`);
}
