// Owns domain error codes and HTTP status metadata; transport serialization belongs to adapters.
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
