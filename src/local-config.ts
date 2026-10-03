// Owns local Git metadata defaults; store initialization and issue operations stay outside.
import { execFileSync } from 'node:child_process';
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PolylinedbError } from './issues.ts';
import { parsePrefix } from './issue-id.ts';

export type RepositoryDefaults = {
  version: 2;
  data_dir: string;
  tool: string;
  project: string;
  actor: string;
  prefix: string;
};

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

function parseDefaults(value: unknown, found: Repository, allowMissing = false): RepositoryDefaults {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid('Repository defaults must be an object');
  const input = value as Record<string, unknown>;
  if (input.version === 1) return invalid('Repository defaults version 1 is unsupported; recreate the local configuration with a prefix');
  const allowed = ['version', 'data_dir', 'tool', 'project', 'actor', 'prefix'];
  if (Object.keys(input).length !== allowed.length || allowed.some(key => !Object.hasOwn(input, key))
    || Object.keys(input).some(key => !allowed.includes(key)) || input.version !== 2) return invalid('Repository defaults have an unsupported shape or version');
  let prefix: string;
  try { prefix = parsePrefix(input.prefix); }
  catch { return invalid('Repository default prefix must match [a-z][a-z0-9]{0,15}'); }
  const name = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || value.trim().length === 0 || /\p{Cc}/u.test(value)
      || Buffer.byteLength(value) > 256) return invalid(`Repository default ${field} is invalid`);
    return value;
  };
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

function readDefaults(path: string, found: Repository): RepositoryDefaults | undefined {
  let descriptor: number;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) return invalid('Repository configuration must be a regular file with mode 0600');
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (missing(error)) return undefined;
    if (error instanceof PolylinedbError) throw error;
    return invalid('Repository configuration cannot be read safely');
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > maximumBytes) return invalid('Repository configuration is invalid or too large');
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

export function readRepositoryDefaults(cwd = process.cwd()): RepositoryDefaults | undefined {
  const found = repository(cwd);
  return found === undefined ? undefined : readDefaults(join(found.common, 'polylinedb.json'), found);
}

export function validateRepositoryDefaults(defaults: RepositoryDefaults, cwd = process.cwd()): RepositoryDefaults {
  const found = repository(cwd);
  if (found === undefined) return invalid('Stealth configuration requires a Git work repository');
  return parseDefaults(defaults, found, true);
}

export function writeRepositoryDefaults(defaults: RepositoryDefaults, cwd = process.cwd()): string {
  const found = repository(cwd);
  if (found === undefined) return invalid('Stealth configuration requires a Git work repository');
  const parsed = parseDefaults(defaults, found);
  const path = join(found.common, 'polylinedb.json');
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
}
