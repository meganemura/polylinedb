#!/usr/bin/env node
// This boundary translates command arguments; the shared domain owns issue rules.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PolylinedbError, executeOperation, parseOperation } from './issues.ts';
import { initializeStore, openStore } from './sqlite.ts';

const help = `polylinedb (polyline database) stores personal issues in one local SQLite database.
Usage: pd [--data-dir ABSOLUTE_PATH] [--actor IDENTITY] COMMAND [OPTIONS]
All commands return JSON. --json is accepted anywhere. Help returns text.
Use -- before a positional query that starts with a dash.
An option consumes its value, so --body --help stores the text --help.
Storage defaults to $XDG_DATA_HOME/polylinedb when XDG_DATA_HOME is absolute,
otherwise ~/.local/share/polylinedb. POLYLINEDB_DATA_DIR and POLYLINEDB_ACTOR are supported.
Storage must be outside the working directory and its Git repository.

Commands:
  init
  actor                         Show the explicit actor, or local:reader.
  create --tool NAME --project NAME --body TEXT [--parent ID]
         [--type bug|task|epic|feature|chore] [--status STATUS]
         [--priority 0..4] [--label NAME ...]
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

Examples:
  pd --actor local:agent create --tool codex --project demo --body 'Fix parser'
  pd show ISSUE_ID
  pd --actor local:agent update ISSUE_ID --body 'New text' --expect body=1
  pd --actor local:agent close ISSUE_ID --expected 1
`;
const fields = ['tool', 'project', 'body', 'status', 'type', 'priority', 'labels'];
const globals = ['data-dir', 'actor'];
const commandFlags: Record<string, readonly string[]> = {
  init: [], actor: [], show: [],
  create: ['tool', 'project', 'body', 'body-file', 'type', 'status', 'priority', 'label', 'parent'],
  comment: ['body', 'body-file'],
  update: ['tool', 'project', 'body', 'body-file', 'type', 'status', 'priority', 'label', 'clear-labels', 'expect'],
  close: ['expected'], reopen: ['expected'],
  list: ['tool', 'project', 'status', 'type', 'priority', 'label', 'after', 'limit'],
  search: ['tool', 'project', 'status', 'type', 'priority', 'label', 'after', 'limit'],
};
function invalid(message: string): never { throw new PolylinedbError('invalid_input', message, 400); }
function integer(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) invalid('Expected an unsigned integer');
  const number = Number(value);
  if (!Number.isSafeInteger(number)) invalid('Integer exceeds the safe range');
  return number;
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
    const value = name === 'clear-labels' ? 'true' : args[++index];
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
  const actor = one('actor') ?? process.env.POLYLINEDB_ACTOR ?? 'local:reader';
  if (!actor.trim() || /\p{Cc}/u.test(actor) || Buffer.byteLength(actor) > 256) invalid('Invalid actor identity');
  if (['create', 'comment', 'update', 'close', 'reopen'].includes(command) && one('actor') === undefined && !process.env.POLYLINEDB_ACTOR) invalid('An explicit --actor or POLYLINEDB_ACTOR is required');
  if (command === 'actor') { process.stdout.write(JSON.stringify({ actor }) + '\n'); return; }
  const directory = one('data-dir') ?? process.env.POLYLINEDB_DATA_DIR ?? join(
    process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME) ? process.env.XDG_DATA_HOME : join(homedir(), '.local', 'share'), 'polylinedb');
  if (command === 'init') { process.stdout.write(JSON.stringify(initializeStore({ directory })) + '\n'); return; }
  const raw: Record<string, unknown> = { op: command };
  if (needsOperand) raw[command === 'search' ? 'query' : 'id'] = operands[0];
  if (one('body') !== undefined && one('body-file') !== undefined) invalid('Use either --body or --body-file');
  const bodyFile = one('body-file');
  let body = one('body');
  if (bodyFile !== undefined) {
    if (bodyFile === '-') {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      body = Buffer.concat(chunks).toString('utf8');
    } else body = await readFile(bodyFile, 'utf8');
  }
  for (const name of ['tool', 'project', 'status', 'type', 'parent', 'after']) if (one(name) !== undefined) raw[name] = one(name);
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
