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

const listed = (kind: string, names: readonly string[]) => `${kind} field${names.length === 1 ? '' : 's'}: ${names.join(', ')}`;
export function requireFields(input: Record<string, unknown>, allowed: readonly string[], required: readonly string[], at?: string): void {
  const path = (key: string) => at === undefined ? key : `${at}.${key}`;
  const unexpected = Object.keys(input).filter(key => !allowed.includes(key)).map(path);
  const missing = required.filter(key => !Object.hasOwn(input, key)).map(path);
  const problems = [...(unexpected.length ? [listed('unexpected', unexpected)] : []), ...(missing.length ? [listed('missing', missing)] : [])];
  if (!problems.length) return;
  const message = problems.join('; ');
  throw new PolylinedbError('invalid_input', message[0].toUpperCase() + message.slice(1));
}
export function expectedType(path: string, type: string): never {
  throw new PolylinedbError('invalid_input', `${path}: expected ${type}`);
}
