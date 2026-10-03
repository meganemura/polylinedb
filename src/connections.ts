// Owns non-secret named connections and selection precedence; execution and credentials stay outside.
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { PolylinedbError } from './issues.ts';
import type { RepositoryConfiguration } from './local-config.ts';
import { validateExternalDirectory } from './local-config.ts';

export type ConnectionDefinition = { kind: 'local'; data_dir: string } | { kind: 'cloud'; url: string };
export type NamedConnection = { name: string; definition: ConnectionDefinition };
export type ConnectionSource = 'flag' | 'environment' | 'repository' | 'user_default' | 'legacy_default';
export type SelectedConnection =
  | { kind: 'local'; name: string | null; directory: string; source: ConnectionSource }
  | { kind: 'cloud'; name: string; url: string; source: ConnectionSource };
const maximumBytes = 16384;
const invalid = (message: string): never => { throw new PolylinedbError('invalid_connection_config', message, 400); };
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

export function parseConnectionName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) return invalid('Connection name must match [a-z][a-z0-9_-]{0,63}');
  return value;
}

function parseDefinition(value: unknown): ConnectionDefinition {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid('Connection definition must be an object');
  if (!('kind' in value)) return invalid('Connection definition requires kind');
  if (value.kind === 'local' && 'data_dir' in value && Object.keys(value).length === 2) {
    if (typeof value.data_dir !== 'string' || !isAbsolute(value.data_dir) || /\p{Cc}/u.test(value.data_dir)) return invalid('Local data_dir must be an absolute directory');
    return { kind: 'local', data_dir: validateExternalDirectory(resolve(value.data_dir)) };
  }
  if (value.kind === 'cloud' && 'url' in value && Object.keys(value).length === 2) {
    if (typeof value.url !== 'string' || /[\s?#\p{Cc}]/u.test(value.url)) return invalid('Cloud URL must be an HTTPS origin');
    let url: URL;
    try { url = new URL(value.url); } catch { return invalid('Cloud URL must be an HTTPS origin'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return invalid('Cloud URL must be an HTTPS origin without credentials, a path, a query, or a fragment');
    return { kind: 'cloud', url: url.origin };
  }
  return invalid('Connection definition has an unsupported shape');
}

export function connectionConfigDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.XDG_CONFIG_HOME;
  if (configured !== undefined && !isAbsolute(configured)) return invalid('XDG_CONFIG_HOME must be absolute');
  const root = configured ?? join(homedir(), '.config');
  try {
    const stat = lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return invalid('Connection configuration home must be a real directory');
  } catch (error) { if (!missing(error)) throw error; }
  const directory = join(root, 'polylinedb');
  validateExternalDirectory(directory);
  return directory;
}

function checkDirectory(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return invalid('Connection configuration directories must be real directories');
    if ((stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid())) return invalid('Connection configuration directory must be owned by the current user with mode 0700');
  } catch (error) { if (!missing(error)) throw error; }
}

function prepareDirectory(path: string): void {
  checkDirectory(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  checkDirectory(path);
}

function readJson(path: string): unknown | undefined {
  let descriptor: number;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600
      || (process.getuid && stat.uid !== process.getuid())) return invalid('Connection configuration must be a private regular file with mode 0600');
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) { if (missing(error)) return undefined; throw error; }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > maximumBytes
      || (process.getuid && stat.uid !== process.getuid())) return invalid('Connection configuration is invalid or too large');
    const buffer = Buffer.alloc(maximumBytes + 1);
    const count = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (count > maximumBytes) return invalid('Connection configuration is too large');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count))); }
    catch { return invalid('Connection configuration must contain valid UTF-8 JSON'); }
  } finally { closeSync(descriptor); }
}

function writeJson(path: string, value: unknown, replace: boolean): void {
  const temporary = join(dirname(path), `.connection-${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    try { writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n'); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    if (replace) renameSync(temporary, path);
    else linkSync(temporary, path);
  } finally { try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; } }
}

export function readConnections(environment: NodeJS.ProcessEnv = process.env): { connections: NamedConnection[]; defaultName: string | undefined } {
  const directory = connectionConfigDirectory(environment);
  checkDirectory(directory);
  const definitions = join(directory, 'connections');
  checkDirectory(definitions);
  let files: string[];
  try { files = readdirSync(definitions); } catch (error) { if (!missing(error)) throw error; files = []; }
  const connections = files.filter(file => !file.startsWith('.')).sort().map(file => {
    if (!file.endsWith('.json')) return invalid('Unexpected file in connection definitions');
    const name = parseConnectionName(file.slice(0, -5));
    const value = readJson(join(definitions, file));
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !('version' in value)
      || value.version !== 1 || !('definition' in value) || Object.keys(value).length !== 2) return invalid('Named connection has an unsupported shape or version');
    return { name, definition: parseDefinition(value.definition) };
  });
  const selected = readJson(join(directory, 'default.json'));
  let defaultName: string | undefined;
  if (selected !== undefined) {
    if (selected === null || typeof selected !== 'object' || Array.isArray(selected) || !('version' in selected)
      || selected.version !== 1 || !('connection' in selected) || Object.keys(selected).length !== 2) return invalid('Default connection has an unsupported shape or version');
    defaultName = parseConnectionName(selected.connection);
    requireConnection(defaultName, connections);
  }
  return { connections, defaultName };
}

export function requireConnection(name: string, connections: NamedConnection[]): NamedConnection {
  parseConnectionName(name);
  const connection = connections.find(connection => connection.name === name);
  if (connection === undefined) throw new PolylinedbError('unknown_connection', `Unknown connection ${name}`, 404);
  return connection;
}

export function addConnection(name: string, definition: ConnectionDefinition, environment: NodeJS.ProcessEnv = process.env): NamedConnection {
  parseConnectionName(name);
  const parsed = parseDefinition(definition);
  const { connections } = readConnections(environment);
  const existing = connections.find(connection => connection.name === name);
  if (existing !== undefined) {
    if (JSON.stringify(existing.definition) !== JSON.stringify(parsed)) throw new PolylinedbError('connection_conflict', 'Connection already exists with different values', 409);
    return existing;
  }
  const directory = connectionConfigDirectory(environment);
  prepareDirectory(directory);
  prepareDirectory(join(directory, 'connections'));
  const path = join(directory, 'connections', `${name}.json`);
  try { writeJson(path, { version: 1, definition: parsed }, false); }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    const concurrent = requireConnection(name, readConnections(environment).connections);
    if (JSON.stringify(concurrent.definition) !== JSON.stringify(parsed)) throw new PolylinedbError('connection_conflict', 'Connection already exists with different values', 409);
  }
  return { name, definition: parsed };
}

export function defaultConnection(name: string, environment: NodeJS.ProcessEnv = process.env): void {
  const current = readConnections(environment);
  requireConnection(name, current.connections);
  if (current.defaultName === name) return;
  const directory = connectionConfigDirectory(environment);
  prepareDirectory(directory);
  writeJson(join(directory, 'default.json'), { version: 1, connection: name }, true);
}

export function selectConnection(input: {
  connection: string | undefined; directory: string | undefined; environment: NodeJS.ProcessEnv;
  repository: RepositoryConfiguration | undefined; connections: NamedConnection[]; defaultName: string | undefined; fallbackDirectory: string;
}): SelectedConnection {
  const named = (name: string, source: ConnectionSource): SelectedConnection => {
    const { definition } = requireConnection(name, input.connections);
    return definition.kind === 'local' ? { kind: 'local', name, directory: definition.data_dir, source }
      : { kind: 'cloud', name, url: definition.url, source };
  };
  if (input.connection !== undefined && input.directory !== undefined) return invalid('Use either --connection or --data-dir');
  if (input.connection !== undefined) return named(input.connection, 'flag');
  if (input.directory !== undefined) return { kind: 'local', name: null, directory: input.directory, source: 'flag' };
  const connection = input.environment.POLYLINEDB_CONNECTION;
  const directory = input.environment.POLYLINEDB_DATA_DIR;
  if (connection !== undefined && directory !== undefined) return invalid('Use either POLYLINEDB_CONNECTION or POLYLINEDB_DATA_DIR');
  if (connection !== undefined) return named(connection, 'environment');
  if (directory !== undefined) return { kind: 'local', name: null, directory, source: 'environment' };
  if (input.repository?.version === 3) return named(input.repository.connection, 'repository');
  if (input.repository?.version === 2) return { kind: 'local', name: null, directory: input.repository.data_dir, source: 'repository' };
  if (input.defaultName !== undefined) return named(input.defaultName, 'user_default');
  return { kind: 'local', name: null, directory: input.fallbackDirectory, source: 'legacy_default' };
}
