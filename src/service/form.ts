/** Reads a bounded application/x-www-form-urlencoded body. Field meaning belongs to the handler that reads it. */

/** Large enough for a full issue body in the edit form, as 65536 UTF-8 bytes can grow threefold when percent-encoded. */
export const formLimitBytes = 256 * 1024;

export async function readForm(request: Request, limitBytes = formLimitBytes): Promise<URLSearchParams | 'invalid'> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limitBytes) return 'invalid';
  if (request.body === null) return new URLSearchParams();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel();
        return 'invalid';
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return new URLSearchParams();
  const media = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (media !== 'application/x-www-form-urlencoded') return 'invalid';
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return 'invalid'; }
}
