// Turns an unexpected failure into the public internal_error object for the CLI.
// The bootstrap imports it before runtime admission, so it must stay free of imports.
// It does not classify known domain or authentication errors; their adapters own those messages.

export interface UnexpectedErrorDiagnostic {
  readonly code?: string;
  readonly errcode?: number;
  readonly errno?: number;
  readonly syscall?: string;
}

export interface InternalError {
  readonly code: 'internal_error';
  readonly message: string;
  readonly details?: { readonly diagnostic: UnexpectedErrorDiagnostic };
}

export const unexpectedErrorGuidance = 'The command failed on an unexpected error. Report the command and error.details.diagnostic to the maintainers.';

// Each field is copied only when its shape cannot carry free text. A SQLite trigger chooses
// its abort message, and filesystem errors carry local paths, so message, path, errstr, cause
// and stack never reach the output.
export function diagnoseUnexpectedError(error: unknown): UnexpectedErrorDiagnostic | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const diagnostic: { code?: string; errcode?: number; errno?: number; syscall?: string } = {};
  const fields = error as Record<string, unknown>;
  if (typeof fields.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(fields.code)) diagnostic.code = fields.code;
  if (Number.isSafeInteger(fields.errcode)) diagnostic.errcode = fields.errcode as number;
  if (Number.isSafeInteger(fields.errno)) diagnostic.errno = fields.errno as number;
  if (typeof fields.syscall === 'string' && /^[a-z][a-z0-9_]{0,31}$/.test(fields.syscall)) diagnostic.syscall = fields.syscall;
  return Object.keys(diagnostic).length > 0 ? diagnostic : undefined;
}

export function describeUnexpectedError(error: unknown): InternalError {
  const diagnostic = diagnoseUnexpectedError(error);
  return { code: 'internal_error', message: unexpectedErrorGuidance, ...(diagnostic === undefined ? {} : { details: { diagnostic } }) };
}
