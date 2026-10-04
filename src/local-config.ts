// Owns local Git metadata defaults; store initialization and issue operations stay outside.
import { execFileSync } from 'node:child_process';
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PolylinedbError } from './records/index.ts';
import { parsePrefix } from './records/index.ts';

export type RepositoryDefaults = {
  version: 2;
  data_dir: string;
  tool: string;
  project: string;
  actor: string;
  prefix: string;
};
export type RepositorySelection = {
  version: 3;
  connection: string;
  tool: string;
  project: string;
  prefix: string;
  actor?: string;
};
export type RepositoryConfiguration = RepositoryDefaults | RepositorySelection;

type Repository = { root: string; common: string };
const maximumBytes = 16384;
const invalid = (message: string): never => { throw new PolylinedbError('invalid_repository_config', message, 400); };
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

function repository(cwd: string): Repository | undefined {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  const location = realpathSync(cwd);
  try {
    const result = execFileSync('git', ['-C', location, 'rev-parse', '--is-inside-work-tree', '--show-toplevel', '--git-common-dir'], {
      env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: maximumBytes,
    });
    const lines = result.trimEnd().split('\n');
    if (lines.length !== 3 || lines[0] !== 'true') return undefined;
    const root = realpathSync(lines[1]);
    const common = realpathSync(resolve(location, lines[2]));
    if (!statSync(common).isDirectory()) return invalid('Git common metadata is not a directory');
    return { root, common };
  } catch (error) {
    if (missing(error) && error instanceof Error && 'syscall' in error && error.syscall === 'spawnSync git') {
      throw new PolylinedbError('git_unavailable', 'Git must be installed and available on PATH to resolve repository defaults safely.', 400);
    }
    if (error instanceof Error && 'status' in error && error.status === 128) return undefined;
    throw error;
  }
}

export function repositoryConfigPath(cwd = process.cwd()): string | undefined {
  const found = repository(cwd);
  return found === undefined ? undefined : join(found.common, 'polylinedb.json');
}

function inside(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return suffix === '' || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function plannedDirectory(path: string): string {
  try {
    lstatSync(path);
  } catch (error) {
    if (!missing(error)) throw error;
    const parent = dirname(path);
    if (parent === path) return invalid('Repository data_dir cannot be resolved');
    return join(plannedDirectory(parent), relative(parent, path));
  }
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) return invalid('Repository data_dir must be a directory');
  return canonical;
}

export function validateExternalDirectory(path: string, cwd = process.cwd()): string {
  if (!isAbsolute(path) || /\p{Cc}/u.test(path)) return invalid('Configuration directory must be absolute');
  const directory = plannedDirectory(path);
  const found = repository(cwd);
  if (found !== undefined && (inside(directory, found.root) || inside(directory, found.common))) return invalid('Configuration directory must stay outside Git repositories and metadata');
  for (let current = directory; ; current = dirname(current)) {
    try { lstatSync(join(current, '.git')); return invalid('Configuration directory must stay outside Git repositories'); }
    catch (error) { if (!missing(error)) throw error; }
    if (dirname(current) === current) break;
  }
  return directory;
}

function parseDefaults(value: unknown, found: Repository, allowMissing = false): RepositoryConfiguration {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid('Repository defaults must be an object');
  const input = value as Record<string, unknown>;
  if (input.version === 1) return invalid('Repository defaults version 1 is unsupported; recreate the local configuration with a prefix');
  const required = input.version === 3 ? ['version', 'connection', 'tool', 'project', 'prefix'] : ['version', 'data_dir', 'tool', 'project', 'actor', 'prefix'];
  const allowed = input.version === 3 ? [...required, 'actor'] : required;
  if (required.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !allowed.includes(key))
    || (input.version !== 2 && input.version !== 3)) return invalid('Repository defaults have an unsupported shape or version');
  let prefix: string;
  try { prefix = parsePrefix(input.prefix); }
  catch { return invalid('Repository default prefix must match [a-z][a-z0-9]{0,15}'); }
  const name = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.trim().length === 0 || /\p{Cc}/u.test(value)
      || Buffer.byteLength(value) > 256) return invalid(`Repository default ${field} is invalid`);
    return value;
  };
  if (input.version === 3) {
    if (typeof input.connection !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(input.connection)) return invalid('Repository connection name is invalid');
    return { version: 3, connection: input.connection, tool: name(input.tool, 'tool'), project: name(input.project, 'project'), prefix,
      ...(Object.hasOwn(input, 'actor') ? { actor: name(input.actor, 'actor') } : {}) };
  }
  if (typeof input.data_dir !== 'string' || !isAbsolute(input.data_dir) || input.data_dir.includes('\u0000')) return invalid('Repository data_dir must be an absolute external directory');
  let directory: string;
  try {
    directory = allowMissing ? plannedDirectory(input.data_dir) : realpathSync(input.data_dir);
    if (!allowMissing && !statSync(directory).isDirectory()) return invalid('Repository data_dir must be a directory');
  } catch (error) {
    if (error instanceof PolylinedbError) throw error;
    return invalid('Repository data_dir must exist before configuration');
  }
  if (inside(directory, found.root) || inside(directory, found.common)) return invalid('Repository data_dir must stay outside Git repositories and metadata');
  for (let current = directory; ; current = dirname(current)) {
    try { lstatSync(join(current, '.git')); return invalid('Repository data_dir must stay outside Git repositories'); }
    catch (error) { if (!missing(error)) throw error; }
    if (dirname(current) === current) break;
  }
  return { version: 2, data_dir: directory, tool: name(input.tool, 'tool'), project: name(input.project, 'project'), actor: name(input.actor, 'actor'), prefix };
}

function readDefaults(path: string, found: Repository): RepositoryConfiguration | undefined {
  let descriptor: number;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600
      || (process.getuid && stat.uid !== process.getuid())) return invalid('Repository configuration must be a regular file owned by the current user with mode 0600');
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (missing(error)) return undefined;
    if (error instanceof PolylinedbError) throw error;
    return invalid('Repository configuration cannot be read safely');
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > maximumBytes
      || (process.getuid && stat.uid !== process.getuid())) return invalid('Repository configuration is invalid or too large');
    const buffer = Buffer.alloc(maximumBytes + 1);
    const count = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (count > maximumBytes) return invalid('Repository configuration is too large');
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count));
      return parseDefaults(JSON.parse(content), found);
    } catch (error) {
      if (error instanceof PolylinedbError) throw error;
      return invalid('Repository configuration must contain valid UTF-8 JSON');
    }
  } finally { closeSync(descriptor); }
}

function mutateRepository(path: string, action: () => string): string {
  const lock = `${path}.lock`;
  let descriptor: number | undefined;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 200; attempt++) {
    try { descriptor = openSync(lock, 'wx', 0o600); break; }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  if (descriptor === undefined) return invalid('Repository configuration is locked; check the other configuration writer');
  try { return action(); }
  finally { closeSync(descriptor); unlinkSync(lock); }
}

export function readRepositoryDefaults(cwd = process.cwd()): RepositoryConfiguration | undefined {
  const found = repository(cwd);
  return found === undefined ? undefined : readDefaults(join(found.common, 'polylinedb.json'), found);
}

export function validateRepositoryDefaults(defaults: RepositoryDefaults, cwd = process.cwd()): RepositoryDefaults {
  const found = repository(cwd);
  if (found === undefined) return invalid('Stealth configuration requires a Git work repository');
  const parsed = parseDefaults(defaults, found, true);
  if (parsed.version !== 2) return invalid('Expected local repository defaults');
  return parsed;
}

export function writeRepositoryDefaults(defaults: RepositoryConfiguration, cwd = process.cwd()): string {
  const found = repository(cwd);
  if (found === undefined) return invalid('Stealth configuration requires a Git work repository');
  const parsed = parseDefaults(defaults, found);
  const path = join(found.common, 'polylinedb.json');
  return mutateRepository(path, () => {
    const existing = readDefaults(path, found);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(parsed)) return invalid('Repository defaults already exist with different values');
      return path;
    }
    const temporary = join(found.common, `.polylinedb-${randomUUID()}.tmp`);
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      try {
        writeFileSync(descriptor, JSON.stringify(parsed, null, 2) + '\n');
        fsyncSync(descriptor);
      } finally { closeSync(descriptor); }
      try { linkSync(temporary, path); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        const concurrent = readDefaults(path, found);
        if (JSON.stringify(concurrent) !== JSON.stringify(parsed)) return invalid('Repository defaults already exist with different values');
      }
      return path;
    } finally { unlinkSync(temporary); }
  });
}

export function useRepositoryConnection(connection: string, cwd = process.cwd()): string {
  const found = repository(cwd);
  if (found === undefined) return invalid('Connection selection requires a Git work repository');
  const path = join(found.common, 'polylinedb.json');
  return mutateRepository(path, () => {
    const existing = readDefaults(path, found);
    if (existing === undefined) return invalid('Initialize repository defaults before selecting a connection');
    const selected = parseDefaults({ version: 3, connection, tool: existing.tool, project: existing.project,
      prefix: existing.prefix, ...(existing.actor === undefined ? {} : { actor: existing.actor }) }, found);
    if (JSON.stringify(existing) === JSON.stringify(selected)) return path;
    const temporary = join(found.common, `.polylinedb-${randomUUID()}.tmp`);
    const writer = openSync(temporary, 'wx', 0o600);
    try {
      try { writeFileSync(writer, JSON.stringify(selected, null, 2) + '\n'); fsyncSync(writer); }
      finally { closeSync(writer); }
      renameSync(temporary, path);
    } finally { try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; } }
    return path;
  });
}
