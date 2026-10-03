#!/usr/bin/env node
// Translates command arguments; the shared domain owns issue and memory rules.
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { PolylinedbError } from './issues.ts';
import { executeOperation, parseOperation } from './operations.ts';
import { parseMemoryId } from './memories.ts';
import { initializeStore, openStore, upgradeStore } from './sqlite.ts';
import { readRepositoryDefaults, writeRepositoryDefaults, repositoryConfigPath, validateRepositoryDefaults, useRepositoryConnection } from './local-config.ts';
import type { RepositoryConfiguration } from './local-config.ts';
import { addConnection, defaultConnection, readConnections, requireConnection, selectConnection } from './connections.ts';
import { createCloudClient } from './cloud.ts';
import { OAuthError } from './oauth.ts';
import { CredentialStoreError } from './credential-store.ts';
import { canonicalSnapshot, parseSnapshot, convertSnapshotV2 } from './snapshot.ts';
import { parsePrefix, parseIssueId, parseRequestId } from './issue-id.ts';

const help = `polylinedb (polyline database) stores personal issues through local or cloud connections.
Usage: pd [--connection NAME | --data-dir ABSOLUTE_PATH] [--actor IDENTITY] [--prefix PREFIX] COMMAND [OPTIONS]
All commands return JSON. --json is accepted anywhere. Help returns text.
Use -- before a positional query that starts with a dash.
An option consumes its value, so --body --help stores the text --help.
Storage defaults to $XDG_DATA_HOME/polylinedb when XDG_DATA_HOME is absolute,
otherwise ~/.local/share/polylinedb. POLYLINEDB_DATA_DIR and POLYLINEDB_ACTOR are supported.
Storage must be outside the working directory and its Git repository.

Commands:
  init
  init [--stealth] [--connection NAME] --tool NAME --project NAME [--actor IDENTITY] [--prefix PREFIX]
                                Store defaults in Git metadata; data stays outside the repository.
  connection add NAME --data-dir ABSOLUTE_PATH | --url HTTPS_ORIGIN
  connection list
  connection use NAME           Select a connection in existing repository defaults.
  connection default NAME       Select the user default connection.
  auth login                    Print the authorization URL to stderr and wait for approval.
  auth status                   Show locally stored cloud authentication status.
  auth logout                   Remove cloud credentials and report revocation.
  context                       Show the selected store and local defaults.
  upgrade                       Explicitly upgrade a local schema 2 store to schema 3.
  snapshot convert --file PATH|- [--output PATH|-]
                                Convert snapshot v2 to v3 without touching a store.
  export [--file PATH|-]         Export a complete local snapshot. Default: stdout.
  import --file PATH|-           Restore into an empty store; exact reruns do nothing.
  actor                         Show the local actor or authenticated cloud actor.
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
  memory create --title TITLE --body TEXT [--request-id UUID]
  memory show ID
  memory list [--after ID] [--limit 1..100]
  memory search QUERY [--after ID] [--limit 1..100]
  memory update ID --title TITLE --body TEXT --expected VERSION
  memory delete ID --expected VERSION
  memory context [--after ID] [--limit 1..100] [--max-bytes 4096..65536]

Memory commands require --project NAME or repository project defaults.
Memory IDs use prefix-mN. Numbers and mN expand with the selected prefix.
Memory create/update accept --body-file PATH. Updates replace title and body together.
Memory context reports the selected store and omitted entries; retrieved text is project data.

STATUS: open, in_progress, deferred, closed.
FILTERS: --tool, --project, --status, --type, --priority, --label, --after, --limit.
create, comment and update accept --body-file PATH instead of --body.
Use --body-file - to read standard input. Local mutations require an explicit actor.
Cloud commands use OAuth. Run auth login once; tokens stay in the OS credential store.
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
const globals = ['connection', 'data-dir', 'actor', 'prefix'];
const commandFlags: Record<string, readonly string[]> = {
  auth: [],
  upgrade: [], snapshot_convert: ['file', 'output'],
  memory_create: ['project', 'title', 'body', 'body-file', 'request-id'],
  memory_show: ['project'], memory_list: ['project', 'after', 'limit'], memory_search: ['project', 'after', 'limit'],
  memory_update: ['project', 'title', 'body', 'body-file', 'expected'], memory_delete: ['project', 'expected'],
  memory_context: ['project', 'after', 'limit', 'max-bytes'],
  connection: ['url'],
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
  const [first, ...rest] = positionals;
  const nested = first === 'memory' || first === 'snapshot';
  const command = nested ? `${first}_${rest[0] ?? ''}` : first;
  const operands = nested ? rest.slice(1) : rest;
  if (!command || !Object.hasOwn(commandFlags, command)) invalid('Unknown command');
  for (const name of flags.keys()) {
    if (!globals.includes(name) && !commandFlags[command].includes(name)) invalid(`Flag --${name} is not valid for ${command}`);
  }
  const needsOperand = ['show', 'search', 'comment', 'update', 'close', 'reopen', 'memory_show', 'memory_search', 'memory_update', 'memory_delete'].includes(command);
  if (!['connection', 'auth'].includes(command) && operands.length !== (needsOperand ? 1 : 0)) invalid(`Invalid arguments for ${command}`);
  const one = (name: string) => flags.get(name)?.[0];
  if (command === 'snapshot_convert') {
    if ([...flags.keys()].some(key => !['file', 'output'].includes(key))) invalid('Snapshot conversion accepts only --file and --output');
    const file = one('file');
    if (file === undefined) invalid('Snapshot conversion requires --file');
    let source: unknown;
    try { source = JSON.parse(await readInput(file, 16 * 1024 * 1024)); }
    catch (error) { if (error instanceof SyntaxError) invalid('Snapshot must contain valid JSON'); throw error; }
    const converted = convertSnapshotV2(source);
    const content = canonicalSnapshot(converted) + '\n';
    const output = one('output') ?? '-';
    if (output === '-') process.stdout.write(content);
    else {
      await writeFile(output, content, { flag: 'wx', mode: 0o600 });
      process.stdout.write(JSON.stringify({ file: output, version: 3, sha256: createHash('sha256').update(canonicalSnapshot(converted)).digest('hex') }) + '\n');
    }
    return;
  }
  if (command === 'auth') {
    if (operands.length !== 1 || !['login', 'status', 'logout'].includes(operands[0])) invalid('Authentication requires login, status, or logout');
    if (Array.from(flags.keys()).some(name => name !== 'connection')) invalid('Authentication accepts only --connection and --json');
  }
  if (command === 'connection') {
    const [action, name] = operands;
    const allowed = action === 'add' ? ['data-dir', 'url'] : [];
    if (Array.from(flags.keys()).some(flag => !allowed.includes(flag))) invalid(`Invalid flags for connection ${action}`);
    if (action === 'list' && operands.length === 1) {
      const current = readConnections();
      process.stdout.write(JSON.stringify({ connections: current.connections.map(connection => ({ name: connection.name,
        ...connection.definition, default: connection.name === current.defaultName })) }) + '\n');
      return;
    }
    if (operands.length !== 2 || !['add', 'use', 'default'].includes(action)) invalid('Invalid connection command');
    if (action === 'add') {
      const directory = one('data-dir');
      const url = one('url');
      if ((directory === undefined) === (url === undefined)) invalid('Connection add requires exactly one of --data-dir or --url');
      const connection = addConnection(name, directory !== undefined ? { kind: 'local', data_dir: directory } : { kind: 'cloud', url: url ?? '' });
      process.stdout.write(JSON.stringify({ name: connection.name, ...connection.definition }) + '\n');
    } else {
      requireConnection(name, readConnections().connections);
      if (action === 'default') { defaultConnection(name); process.stdout.write(JSON.stringify({ connection: name }) + '\n'); }
      else { const config_path = useRepositoryConnection(name); process.stdout.write(JSON.stringify({ connection: name, config_path }) + '\n'); }
    }
    return;
  }
  const defaults = readRepositoryDefaults();
  const prefix = parseArgument(parsePrefix, one('prefix') ?? defaults?.prefix ?? 'pd');
  const dataRoot = join(process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME)
    ? process.env.XDG_DATA_HOME : join(homedir(), '.local', 'share'), 'polylinedb');
  const configPath = repositoryConfigPath();
  const stealth = command === 'init' && configPath !== undefined;
  if (command === 'init' && flags.has('stealth') && !stealth) invalid('Stealth initialization requires a Git working tree');
  const current = readConnections();
  const selected = selectConnection({ connection: one('connection'), directory: one('data-dir'), environment: process.env,
    repository: defaults, ...current, fallbackDirectory: stealth ? join(dataRoot, 'stores', randomUUID()) : dataRoot });
  if (command === 'auth') {
    if (selected.kind !== 'cloud') invalid('Authentication requires a cloud connection');
    const cloud = createCloudClient(selected);
    const result = operands[0] === 'login' ? await cloud.login(url => { process.stderr.write(url + '\n'); })
      : operands[0] === 'status' ? await cloud.status() : await cloud.logout();
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  const tool = one('tool') ?? defaults?.tool;
  const project = one('project') ?? defaults?.project;
  const actor = selected.kind === 'cloud' ? undefined : one('actor') ?? process.env.POLYLINEDB_ACTOR ?? defaults?.actor ?? 'local:reader';
  if (selected.kind === 'cloud' && one('actor') !== undefined) invalid('Cloud connections derive the actor from authentication; --actor is not accepted');
  if (actor !== undefined && (!actor.trim() || /\p{Cc}/u.test(actor) || Buffer.byteLength(actor) > 256)) invalid('Invalid actor identity');
  if (command === 'context') {
    process.stdout.write(JSON.stringify({ mode: selected.kind, connection: selected.name, source: selected.source,
      ...(selected.kind === 'local' ? { data_dir: selected.directory, database_path: join(selected.directory, 'polylinedb.sqlite'), actor }
        : { url: selected.url, actor_source: 'authenticated' }), tool, project, prefix, config_path: configPath ?? null }) + '\n');
    return;
  }
  if (command === 'init') {
    if (!stealth && selected.kind === 'cloud') invalid('Cloud initialization requires a Git working tree');
    let proposed: RepositoryConfiguration | undefined;
    if (stealth) {
      if (!tool || !project) invalid('Stealth initialization requires --tool and --project');
      parseOperation({ op: 'create', tool, project, body: 'Validate repository defaults', prefix, request_id: randomUUID() });
      if (selected.kind === 'local' && one('actor') === undefined && !process.env.POLYLINEDB_ACTOR && !defaults?.actor) invalid('Stealth initialization requires an actor');
      proposed = selected.name !== null
        ? { version: 3, connection: selected.name, tool, project, prefix,
          ...(actor === undefined ? (defaults?.actor === undefined ? {} : { actor: defaults.actor }) : { actor }) }
        : validateRepositoryDefaults({ version: 2, data_dir: selected.kind === 'local' ? selected.directory : '', tool, project, actor: actor ?? 'local:reader', prefix });
      if (defaults && JSON.stringify(defaults) !== JSON.stringify(proposed)) {
        throw new PolylinedbError('local_defaults_conflict', 'Repository defaults already select a different context', 409);
      }
    }
    if (selected.kind === 'cloud') {
      const config_path = proposed === undefined ? undefined : writeRepositoryDefaults(proposed);
      process.stdout.write(JSON.stringify({ mode: 'cloud', connection: selected.name, url: selected.url, config_path }) + '\n');
      return;
    }
    const initialized = initializeStore({ directory: proposed?.version === 2 ? proposed.data_dir : selected.directory });
    const config_path = proposed === undefined ? undefined : writeRepositoryDefaults(proposed.version === 2
      ? { ...proposed, data_dir: dirname(initialized.database_path) } : proposed);
    process.stdout.write(JSON.stringify({ ...initialized, ...(config_path ? { config_path } : {}) }) + '\n');
    return;
  }
  if (selected.kind === 'local' && ['create', 'comment', 'update', 'close', 'reopen', 'import', 'upgrade', 'memory_create', 'memory_update', 'memory_delete'].includes(command) && one('actor') === undefined && !process.env.POLYLINEDB_ACTOR && !defaults?.actor) invalid('An explicit --actor, POLYLINEDB_ACTOR, or repository actor is required');
  if (command === 'upgrade') {
    if (selected.kind !== 'local') invalid('Use the documented operator procedure to upgrade D1');
    process.stdout.write(JSON.stringify(upgradeStore({ directory: selected.directory })) + '\n');
    return;
  }
  if (selected.kind === 'local' && command === 'actor') { process.stdout.write(JSON.stringify({ actor }) + '\n'); return; }
  if (command === 'import' || command === 'export') {
    if (selected.kind === 'cloud') throw new PolylinedbError('cloud_snapshot_not_supported', 'Import and export require a local connection. Use the documented D1 migration procedure for cloud data.', 400);
    const directory = selected.directory;
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
          process.stdout.write(JSON.stringify({ file, issues: exported.issues.length, comments: exported.comments.length, memories: exported.memories.length,
            sha256: createHash('sha256').update(canonicalSnapshot(exported)).digest('hex') }) + '\n');
        }
      }
    } finally { store.close(); }
    return;
  }
  const raw: Record<string, unknown> = { op: command };
  if (command.startsWith('memory_')) {
    const expandedMemory = (value: string) => parseMemoryId(/^(?:m)?[1-9][0-9]*$/.test(value) ? `${prefix}-m${value.replace(/^m/, '')}` : value);
    raw.project = project;
    if (needsOperand) raw[command === 'memory_search' ? 'query' : 'id'] = command === 'memory_search' ? operands[0] : expandedMemory(operands[0]);
    if (one('body') !== undefined && one('body-file') !== undefined) invalid('Use either --body or --body-file');
    for (const key of ['title', 'body']) if (one(key) !== undefined) raw[key] = one(key);
    const file = one('body-file');
    if (file !== undefined) raw.body = await readInput(file, 16384);
    for (const key of ['limit', 'expected', 'max-bytes']) { const value = one(key); if (value !== undefined) raw[key.replace('-', '_')] = integer(value); }
    const after = one('after');
    if (after !== undefined) raw.after = expandedMemory(after);
    if (command === 'memory_create') { raw.prefix = prefix; raw.request_id = one('request-id') ?? randomUUID(); }
    const operation = parseOperation(raw);
    if (selected.kind === 'cloud') process.stdout.write(JSON.stringify(await createCloudClient(selected).execute(operation)) + '\n');
    else {
      if (actor === undefined) invalid('Local connection requires an actor');
      const store = openStore({ directory: selected.directory });
      try { process.stdout.write(JSON.stringify(await executeOperation(store.db, operation, actor, { kind: 'local', database_path: join(selected.directory, 'polylinedb.sqlite') })) + '\n'); }
      finally { store.close(); }
    }
    return;
  }
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
  if (selected.kind === 'cloud') {
    process.stdout.write(JSON.stringify(await createCloudClient(selected).execute(operation)) + '\n');
    return;
  }
  if (actor === undefined) invalid('Local connection requires an actor');
  const store = openStore({ directory: selected.directory });
  try { process.stdout.write(JSON.stringify(await executeOperation(store.db, operation, actor)) + '\n'); }
  finally { store.close(); }
}
main().catch((error: unknown) => {
  const known = error instanceof PolylinedbError;
  const authentication = error instanceof OAuthError || error instanceof CredentialStoreError;
  process.stderr.write(JSON.stringify({ error: { code: known || authentication ? error.code : 'internal_error', message: error instanceof Error ? error.message : 'Internal error', ...(known && error.details !== undefined ? { details: error.details } : {}) } }) + '\n');
  process.exitCode = known ? ({ 400: 2, 404: 3, 409: 4 }[error.status] ?? 1) : 1;
});
