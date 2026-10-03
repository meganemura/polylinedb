#!/usr/bin/env node
// This boundary translates command arguments; the shared domain owns issue rules.
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { PolylinedbError, executeOperation, parseOperation } from './issues.ts';
import { initializeStore, openStore } from './sqlite.ts';
import { readRepositoryDefaults, writeRepositoryDefaults, repositoryConfigPath, validateRepositoryDefaults } from './local-config.ts';
import { canonicalSnapshot, parseSnapshot } from './snapshot.ts';
import { parsePrefix, parseIssueId, parseRequestId } from './issue-id.ts';

const help = `polylinedb (polyline database) stores personal issues in one local SQLite database.
Usage: pd [--data-dir ABSOLUTE_PATH] [--actor IDENTITY] [--prefix PREFIX] COMMAND [OPTIONS]
All commands return JSON. --json is accepted anywhere. Help returns text.
Use -- before a positional query that starts with a dash.
An option consumes its value, so --body --help stores the text --help.
Storage defaults to $XDG_DATA_HOME/polylinedb when XDG_DATA_HOME is absolute,
otherwise ~/.local/share/polylinedb. POLYLINEDB_DATA_DIR and POLYLINEDB_ACTOR are supported.
Storage must be outside the working directory and its Git repository.

Commands:
  init
  init --stealth --tool NAME --project NAME --actor IDENTITY [--prefix PREFIX]
                                Store defaults in Git metadata; data stays outside the repository.
  context                       Show the selected store and local defaults.
  export [--file PATH|-]         Export a complete local snapshot. Default: stdout.
  import --file PATH|-           Restore into an empty store; exact reruns do nothing.
  actor                         Show the explicit actor, or local:reader.
  create --tool NAME --project NAME --body TEXT [--parent ID]
         [--type bug|task|epic|feature|chore] [--status STATUS]
         [--priority 0..4] [--label NAME ...] [--request-id UUID]
  show ID
  list [FILTERS]
  search QUERY [FILTERS]
  comment ID --body TEXT
  update ID [--tool NAME] [--project NAME] [--body TEXT] [--status STATUS]
         [--type TYPE] [--priority 0..4] [--label NAME ... | --clear-labels]
         --expect FIELD=VERSION [--expect FIELD=VERSION ...]
  close ID --expected VERSION
  reopen ID --expected VERSION

STATUS: open, in_progress, deferred, closed.
FILTERS: --tool, --project, --status, --type, --priority, --label, --after, --limit.
create, comment and update accept --body-file PATH instead of --body.
Use --body-file - to read standard input. Mutations require an explicit actor.
Each update field requires its own expected version from show. Conflicts require rereading.
The prefix defaults to repository settings, otherwise pd. It matches [a-z][a-z0-9]{0,15}.
Issue numbers expand with the selected prefix: show 42 reads pd-42, and show 42.1 reads pd-42.1.
Create retries require the same --request-id and identical input. Omission generates a new UUID.
Automatically generated request IDs are not reused by a later CLI invocation.

Examples:
  pd --actor local:agent create --tool codex --project demo --body 'Fix parser'
  pd show ISSUE_ID
  pd --actor local:agent update ISSUE_ID --body 'New text' --expect body=1
  pd --actor local:agent close ISSUE_ID --expected 1
`;
const fields = ['tool', 'project', 'body', 'status', 'type', 'priority', 'labels'];
const globals = ['data-dir', 'actor', 'prefix'];
const commandFlags: Record<string, readonly string[]> = {
  init: ['stealth', 'tool', 'project'], context: [], export: ['file'], import: ['file'], actor: [], show: [],
  create: ['tool', 'project', 'body', 'body-file', 'type', 'status', 'priority', 'label', 'parent', 'request-id'],
  comment: ['body', 'body-file'],
  update: ['tool', 'project', 'body', 'body-file', 'type', 'status', 'priority', 'label', 'clear-labels', 'expect'],
  close: ['expected'], reopen: ['expected'],
  list: ['tool', 'project', 'status', 'type', 'priority', 'label', 'after', 'limit'],
  search: ['tool', 'project', 'status', 'type', 'priority', 'label', 'after', 'limit'],
};
function invalid(message: string): never { throw new PolylinedbError('invalid_input', message, 400); }
function parseArgument<T>(parser: (value: unknown) => T, value: unknown): T {
  try { return parser(value); }
  catch (error) { return invalid(error instanceof Error ? error.message : 'Invalid argument'); }
}
function integer(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) invalid('Expected an unsigned integer');
  const number = Number(value);
  if (!Number.isSafeInteger(number)) invalid('Integer exceeds the safe range');
  return number;
}
async function readInput(path: string, maximum: number): Promise<string> {
  const input = path === '-' ? process.stdin : createReadStream(path);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > maximum) invalid(`Input exceeds ${maximum} UTF-8 bytes`);
    chunks.push(bytes);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { return invalid('Input must be valid UTF-8'); }
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stdout.write(help);
    return;
  }
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (optionsEnded) { positionals.push(arg); continue; }
    if (arg === '--') { optionsEnded = true; continue; }
    if (arg === '--help' || arg === '-h') { process.stdout.write(help); return; }
    if (arg === '--json') continue;
    if (!arg.startsWith('-')) { positionals.push(arg); continue; }
    if (!arg.startsWith('--')) invalid(`Unknown flag ${arg}`);
    const name = arg.slice(2);
    if (![...globals, ...Object.values(commandFlags).flat()].includes(name)) invalid(`Unknown flag ${arg}`);
    const value = ['clear-labels', 'stealth'].includes(name) ? 'true' : args[++index];
    if (value === undefined || value === '--' || (value.startsWith('--') && value !== '--help')) invalid(`Missing value for ${arg}`);
    const previous = flags.get(name) ?? [];
    if (previous.length && name !== 'label' && name !== 'expect') invalid(`Duplicate flag ${arg}`);
    flags.set(name, [...previous, value]);
  }
  const [command, ...operands] = positionals;
  if (!command || !Object.hasOwn(commandFlags, command)) invalid('Unknown command');
  for (const name of flags.keys()) {
    if (!globals.includes(name) && !commandFlags[command].includes(name)) invalid(`Flag --${name} is not valid for ${command}`);
  }
  const needsOperand = ['show', 'search', 'comment', 'update', 'close', 'reopen'].includes(command);
  if (operands.length !== (needsOperand ? 1 : 0)) invalid(`Invalid arguments for ${command}`);
  const one = (name: string) => flags.get(name)?.[0];
  const defaults = readRepositoryDefaults();
  const prefix = parseArgument(parsePrefix, one('prefix') ?? defaults?.prefix ?? 'pd');
  const actor = one('actor') ?? process.env.POLYLINEDB_ACTOR ?? defaults?.actor ?? 'local:reader';
  if (!actor.trim() || /\p{Cc}/u.test(actor) || Buffer.byteLength(actor) > 256) invalid('Invalid actor identity');
  if (['create', 'comment', 'update', 'close', 'reopen', 'import'].includes(command) && one('actor') === undefined && !process.env.POLYLINEDB_ACTOR && !defaults?.actor) invalid('An explicit --actor, POLYLINEDB_ACTOR, or repository actor is required');
  if (command === 'actor') { process.stdout.write(JSON.stringify({ actor }) + '\n'); return; }
  const dataRoot = join(process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME)
    ? process.env.XDG_DATA_HOME : join(homedir(), '.local', 'share'), 'polylinedb');
  const stealth = command === 'init' && flags.has('stealth');
  let directory = one('data-dir') ?? process.env.POLYLINEDB_DATA_DIR ?? defaults?.data_dir
    ?? (stealth ? join(dataRoot, 'stores', randomUUID()) : dataRoot);
  const tool = one('tool') ?? defaults?.tool;
  const project = one('project') ?? defaults?.project;
  if (command === 'context') {
    process.stdout.write(JSON.stringify({ data_dir: directory, database_path: join(directory, 'polylinedb.sqlite'),
      actor, tool, project, prefix, config_path: repositoryConfigPath() ?? null }) + '\n');
    return;
  }
  if (command === 'init') {
    if (!stealth && (one('tool') !== undefined || one('project') !== undefined)) invalid('Use --stealth to save repository defaults');
    if (stealth) {
      if (!repositoryConfigPath()) invalid('Stealth initialization requires a Git working tree');
      if (!tool || !project) invalid('Stealth initialization requires --tool and --project');
      if (one('actor') === undefined && !process.env.POLYLINEDB_ACTOR && !defaults?.actor) invalid('Stealth initialization requires an actor');
      parseOperation({ op: 'create', tool, project, body: 'Validate repository defaults', prefix, request_id: randomUUID() });
      directory = validateRepositoryDefaults({ version: 2, data_dir: directory, tool, project, actor, prefix }).data_dir;
      if (defaults && (defaults.data_dir !== directory || defaults.tool !== tool || defaults.project !== project || defaults.actor !== actor || defaults.prefix !== prefix)) {
        throw new PolylinedbError('local_defaults_conflict', 'Repository defaults already select a different context', 409);
      }
    }
    const initialized = initializeStore({ directory });
    const config_path = stealth && tool && project
      ? writeRepositoryDefaults({ version: 2, data_dir: dirname(initialized.database_path), tool, project, actor, prefix })
      : undefined;
    process.stdout.write(JSON.stringify({ ...initialized, ...(config_path ? { config_path } : {}) }) + '\n');
    return;
  }
  if (command === 'import' || command === 'export') {
    let snapshot;
    if (command === 'import') {
      const file = one('file');
      if (file === undefined) invalid('Import requires --file');
      let value: unknown;
      try { value = JSON.parse(await readInput(file, 16 * 1024 * 1024)); }
      catch (error) { if (error instanceof SyntaxError) invalid('Snapshot must contain valid JSON'); throw error; }
      snapshot = parseSnapshot(value);
    }
    const store = openStore({ directory });
    try {
      if (snapshot) process.stdout.write(JSON.stringify(store.importSnapshot(snapshot)) + '\n');
      else {
        const exported = store.exportSnapshot();
        const content = JSON.stringify(exported, null, 2) + '\n';
        const file = one('file') ?? '-';
        if (file === '-') process.stdout.write(content);
        else {
          await writeFile(file, content, { flag: 'wx', mode: 0o600 });
          process.stdout.write(JSON.stringify({ file, issues: exported.issues.length, comments: exported.comments.length,
            sha256: createHash('sha256').update(canonicalSnapshot(exported)).digest('hex') }) + '\n');
        }
      }
    } finally { store.close(); }
    return;
  }
  const raw: Record<string, unknown> = { op: command };
  const expandedId = (value: string) => parseArgument(parseIssueId, /^[0-9]+(?:\.[0-9]+)*$/.test(value) ? `${prefix}-${value}` : value);
  if (needsOperand) raw[command === 'search' ? 'query' : 'id'] = command === 'search' ? operands[0] : expandedId(operands[0]);
  if (one('body') !== undefined && one('body-file') !== undefined) invalid('Use either --body or --body-file');
  const bodyFile = one('body-file');
  let body = one('body');
  if (bodyFile !== undefined) {
    body = await readInput(bodyFile, 65536);
  }
  for (const name of ['tool', 'project', 'status', 'type']) if (one(name) !== undefined) raw[name] = one(name);
  for (const name of ['parent', 'after']) {
    const value = one(name);
    if (value !== undefined) raw[name] = expandedId(value);
  }
  if (command === 'create') {
    raw.prefix = prefix;
    raw.request_id = parseArgument(parseRequestId, one('request-id') ?? randomUUID());
    if (raw.tool === undefined && tool !== undefined) raw.tool = tool;
    if (raw.project === undefined && project !== undefined) raw.project = project;
  }
  for (const name of ['priority', 'limit', 'expected']) {
    const value = one(name);
    if (value !== undefined) raw[name] = integer(value);
  }
  if (body !== undefined) raw.body = body;
  if (flags.has('label')) raw[command === 'list' || command === 'search' ? 'label' : 'labels'] = command === 'list' || command === 'search' ? one('label') : flags.get('label');
  if ((command === 'list' || command === 'search') && (flags.get('label')?.length ?? 0) > 1) invalid('Filter --label is a singleton');
  if (command === 'update') {
    if (flags.has('clear-labels') && flags.has('label')) invalid('Use --label or --clear-labels');
    if (flags.has('clear-labels')) raw.labels = [];
    const expectations = new Map<string, number>();
    for (const value of flags.get('expect') ?? []) {
      const match = /^([a-z]+)=([0-9]+)$/.exec(value);
      if (!match || !fields.includes(match[1]) || expectations.has(match[1])) invalid('Invalid or duplicate --expect');
      expectations.set(match[1], integer(match[2]));
    }
    const changes = fields.filter(field => Object.hasOwn(raw, field)).map(field => {
      const expected = expectations.get(field);
      if (expected === undefined) invalid(`Missing --expect ${field}=VERSION`);
      expectations.delete(field);
      return { field, value: raw[field], expected };
    });
    if (expectations.size) invalid('An expectation must match an updated field');
    for (const field of fields) delete raw[field];
    raw.changes = changes;
  }
  const operation = parseOperation(raw);
  const store = openStore({ directory });
  try { process.stdout.write(JSON.stringify(await executeOperation(store.db, operation, actor)) + '\n'); }
  finally { store.close(); }
}
main().catch((error: unknown) => {
  const known = error instanceof PolylinedbError;
  process.stderr.write(JSON.stringify({ error: { code: known ? error.code : 'internal_error', message: error instanceof Error ? error.message : 'Internal error', ...(known && error.details !== undefined ? { details: error.details } : {}) } }) + '\n');
  process.exitCode = known ? ({ 400: 2, 404: 3, 409: 4 }[error.status] ?? 1) : 1;
});
