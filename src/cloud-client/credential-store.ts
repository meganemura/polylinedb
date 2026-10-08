/** Stores credentials through OS commands. Child output stays private and never becomes an error message. */
import { spawn } from 'node:child_process';

const service = 'polylinedb.oauth';
const prefix = 'pd-oauth-v1:';
type Command = { executable: string; args: string[]; input?: string };
type Result = { status: number | null; stdout: string; stderr: string };
type Runner = (command: Command) => Promise<Result>;
interface CredentialStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class CredentialStoreError extends Error {
  readonly code: string;
  constructor(code = 'auth_store_unavailable') {
    super(code === 'auth_store_too_large' ? 'The credential exceeds the OS store size limit.' : 'The OS credential store is unavailable or did not complete the operation.');
    this.name = 'CredentialStoreError';
    this.code = code;
  }
}

/** @internal The runner seam lets tests use a child fixture without opening a live credential store. */
export function runCredentialCommand(command: Command, limits = { timeoutMs: 30_000, outputBytes: 64 * 1024 }): Promise<Result> {
  return new Promise((resolve, reject) => {
    // Without input, a command can exit before the runner writes to a stdin pipe, and that write gets EPIPE.
    const child = command.input === undefined
      ? spawn(command.executable, command.args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(command.executable, command.args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    const fail = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      child.stdin?.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(new CredentialStoreError());
    };
    const timer = setTimeout(fail, limits.timeoutMs);
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.outputBytes) fail();
      else chunks.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.on('error', fail);
    child.stdin?.on('error', fail);
    child.on('close', status => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
        resolve({ status, stdout: decoder.decode(Buffer.concat(stdout)), stderr: decoder.decode(Buffer.concat(stderr)) });
      } catch { reject(new CredentialStoreError()); }
    });
    child.stdin?.end(command.input);
  });
}

function checkKey(key: string): void {
  if (!/^oauth-[a-f0-9]{64}$/.test(key)) throw new CredentialStoreError('auth_store_invalid_key');
}

function encode(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.toString('utf8') !== value) throw new CredentialStoreError('auth_store_invalid_value');
  return prefix + bytes.toString('base64');
}

function decode(value: string): string {
  if (!value.startsWith(prefix)) throw new CredentialStoreError('auth_store_invalid_value');
  const encoded = value.slice(prefix.length);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new CredentialStoreError('auth_store_invalid_value');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new CredentialStoreError('auth_store_invalid_value'); }
}

/** @internal Options are for protocol tests; CLI callers use the host platform and private pipe runner. */
export function createCredentialStore(options: { platform?: string; runner?: Runner } = {}): CredentialStore {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? runCredentialCommand;
  const execute = async (command: Command): Promise<Result> => {
    try { return await runner(command); }
    catch { throw new CredentialStoreError(); }
  };
  const supported = () => {
    if (platform !== 'darwin' && platform !== 'linux') throw new CredentialStoreError();
  };
  const attributes = (key: string) => ['service', service, 'account', key];
  const read = async (key: string): Promise<string | null> => {
    checkKey(key); supported();
    if (platform === 'darwin') {
      const result = await execute({ executable: '/usr/bin/security', args: ['find-generic-password', '-s', service, '-a', key, '-w'] });
      if (result.status === 44) return null;
      if (result.status !== 0) throw new CredentialStoreError();
      // security appends one line terminator to its password output.
      return decode(result.stdout.replace(/\n$/, ''));
    }
    const result = await execute({ executable: '/usr/bin/secret-tool', args: ['lookup', ...attributes(key)] });
    if (result.status === 0 && result.stderr === '') return decode(result.stdout);
    if (result.status !== 1 || result.stdout !== '' || result.stderr !== '') throw new CredentialStoreError();
    // lookup also returns 1 when unlock is cancelled. Search without --unlock distinguishes existing locked items.
    const search = await execute({ executable: '/usr/bin/secret-tool', args: ['search', '--all', ...attributes(key)] });
    if (search.status === 0 && search.stdout === '' && search.stderr === '') return null;
    throw new CredentialStoreError();
  };
  return {
    read,
    async write(key, value) {
      checkKey(key); supported();
      const encoded = encode(value);
      if (platform === 'darwin') {
        // Base64 and validated identifiers keep the interactive parser's single command free of quoting and newlines.
        const input = `add-generic-password -U -s ${service} -a ${key} -w ${encoded}\n`;
        if (Buffer.byteLength(input) >= 4096) throw new CredentialStoreError('auth_store_too_large');
        const result = await execute({ executable: '/usr/bin/security', args: ['-i', '-q'], input });
        if (result.status !== 0) throw new CredentialStoreError();
      } else {
        if (Buffer.byteLength(encoded) > 8191) throw new CredentialStoreError('auth_store_too_large');
        const result = await execute({ executable: '/usr/bin/secret-tool', args: ['store', '--label', 'polylinedb', ...attributes(key)], input: encoded });
        if (result.status !== 0 || result.stderr !== '') throw new CredentialStoreError();
      }
      // security's interactive exit status can hide a failed command, so success requires an exact readback.
      if (await read(key) !== value) throw new CredentialStoreError();
    },
    async delete(key) {
      checkKey(key); supported();
      const result = platform === 'darwin'
        ? await execute({ executable: '/usr/bin/security', args: ['delete-generic-password', '-s', service, '-a', key] })
        : await execute({ executable: '/usr/bin/secret-tool', args: ['clear', ...attributes(key)] });
      const accepted = platform === 'darwin'
        ? result.status === 0 || result.status === 44
        : result.stderr === '' && (result.status === 0 || (result.status === 1 && result.stdout === ''));
      if (!accepted) throw new CredentialStoreError();
      if (await read(key) !== null) throw new CredentialStoreError();
    },
  };
}
