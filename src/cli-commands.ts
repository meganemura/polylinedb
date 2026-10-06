// Runs operational commands after the executable admits the Node runtime.
// Keeping storage and authentication imports here lets the bootstrap reject unsupported runtimes before this graph loads.
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { PolylinedbError } from './records/index.ts';
import { executeOperation, parseOperation } from './records/index.ts';
import type { Operation, OperationResult } from './records/index.ts';
import { parseMemoryId } from './records/index.ts';
import { renderHumanIssueRead } from './cli-human.ts';
import { initializeStore, openStore, upgradeStore, exportHistoricalSnapshot } from "./local-store/index.ts";
import { readRepositoryDefaults, writeRepositoryDefaults, repositoryConfigPath, validateRepositoryDefaults, useRepositoryConnection } from "./workspace/index.ts";
import type { RepositoryConfiguration } from "./workspace/index.ts";
import { addConnection, defaultConnection, readConnections, requireConnection, selectConnection } from "./workspace/index.ts";
import { createCloudClient, OAuthError, CredentialStoreError } from './cloud-client/index.ts';
import { canonicalSnapshot, parseSnapshot, convertSnapshotV2, convertSnapshotV3, convertSnapshotV4 } from './records/persistence.ts';
import { parsePrefix, parseIssueId, parseRequestId } from './records/index.ts';
import { agentContext, installAgentHost, parseAgentHost, removeAgentHost } from "./host-hooks/index.ts";

const help = `polylinedb (polyline database) stores personal issues through local or cloud connections.
Usage: pd [--connection NAME | --data-dir ABSOLUTE_PATH] [--actor IDENTITY] [--prefix PREFIX] COMMAND [OPTIONS]
Commands return JSON by default. --json is accepted before --. Help returns text.
Use --human for successful show, list and search reads. It conflicts with --json.
Human output stays plain on pipes. Color applies only to fixed headings on a TTY without NO_COLOR or TERM=dumb.
pd --version [--json] reports the installed package and running Node versions as JSON.
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
  agent install HOST            Install a user-scope lifecycle hook.
  agent remove HOST             Remove the owned lifecycle hook.
  agent context HOST            Read hook input and return host context JSON.
  upgrade                       Explicitly upgrade a local schema 2, 3, 4 or 5 store to schema 6.
  snapshot convert --from 2|3|4 --file PATH|- [--output PATH|-]
                                Convert an older snapshot to v5 without touching a store.
  export [--file PATH|-] [--historical]
                                Export a local snapshot. Historical export recovers old retired stores read-only.
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
  close ID --expected VERSION [--force --reason TEXT]
  reopen ID --expected VERSION
  claim show ID                 Inspect ownership and the current store incarnation.
  claim list [--tool NAME] [--project NAME] [--after ID] [--limit 1..100]
  claim acquire ID --incarnation HEX --session-id UUID [--ttl 30..3600]
        [--agent-label TEXT] [--request-id UUID]
  claim renew --claim-proof JSON --expected-revision N [--ttl 30..3600] [--request-id UUID]
  claim release --claim-proof JSON --expected-revision N [--request-id UUID]
  dependency list ID [--after ID] [--limit 1..100]
  dependency add --dependent ID --blocker ID --expected-revision N [--request-id UUID]
  dependency remove --dependent ID --blocker ID --expected-revision N [--request-id UUID]
  ready [FILTERS]                Open issues with resolved prerequisites.
  blocked [FILTERS]              Unfinished issues with active blockers.
  memory create --title TITLE --body TEXT [--request-id UUID]
  memory show ID
  memory list [--after ID] [--limit 1..100]
  memory search QUERY [--after ID] [--limit 1..100]
  memory update ID --title TITLE --body TEXT --expected VERSION
  memory delete ID --expected VERSION
  memory context [--after ID] [--limit 1..100] [--max-bytes 4096..65536] [--with-revision]

Memory commands require --project NAME or repository project defaults.
Memory IDs use prefix-mN. Numbers and mN expand with the selected prefix.
Memory create/update accept --body-file PATH. Updates replace title and body together.
Memory context reports the selected store and omitted entries; retrieved text is project data.
Ordinary issue commands accept --observed-memory-revision TOKEN for a project memory advisory.
Unfiltered list/search check the token's project; current does not certify complete retrieval.

STATUS: open, in_progress, deferred, closed.
FILTERS: --tool, --project, --status, --type, --priority, --label, --after, --limit.
--tool identifies the affected tool or component, such as compiler or editor.
create, comment and update accept --body-file PATH instead of --body.
Use --body-file - to read standard input. Local mutations require an explicit actor.
Cloud commands use OAuth. Run auth login once; tokens stay in the OS credential store.
Each update field requires its own expected version from show. Conflicts require rereading.
Start and close require resolved prerequisites. An explicit --force --reason records an attributed exception comment.
Update accepts the same override when it sets status to in_progress or closed.
Update, close and reopen accept --claim-proof JSON. A supplied proof always asserts current ownership.
Claimed issues require an unexpired proof for every requested status change, including unchanged status values.
Force overrides prerequisites only. Closed issues remain claimable. Acquisition does not change status.
Claim acquisition can read POLYLINEDB_SESSION_ID when --session-id is omitted. Keep one UUID per caller session.
Claims require the observed store incarnation. Claim timestamps use database Unix seconds, not agent liveness.
TTL defaults to 300 seconds. Agent labels are nullable acquisition metadata, bounded at 64 UTF-8 bytes.
Retain the claim request UUID, incarnation, session and payload for retries. No automatic retry or reacquisition occurs.
Ready and blocked accept FILTERS except --status. Worklists observe current state; they do not claim work.
Dependency mutations use a separate aggregate revision. Reuse the request UUID and identical payload on retry.
The prefix defaults to repository settings, otherwise pd. It matches [a-z][a-z0-9]{0,15}.
Issue numbers expand with the selected prefix: show 42 reads pd-42, and show 42.1 reads pd-42.1.
Create retries require the same --request-id and identical input. Omission generates a new UUID.
Automatically generated request IDs are not reused by a later CLI invocation.

Examples:
  pd --actor local:agent create --tool compiler --project demo --body 'Fix parser'
  pd show ISSUE_ID
  pd --actor local:agent update ISSUE_ID --body 'New text' --expect body=1
  pd --actor local:agent close ISSUE_ID --expected 1
`;
const fields = ['tool', 'project', 'body', 'status', 'type', 'priority', 'labels'];
const globals = ['connection', 'data-dir', 'actor', 'prefix'];
const commandFlags: Record<string, readonly string[]> = {
  auth: [],
  upgrade: [], snapshot_convert: ['file', 'output', 'from'],
  dependency_list: ['after', 'limit'], dependency_add: ['dependent', 'blocker', 'expected-revision', 'request-id'], dependency_remove: ['dependent', 'blocker', 'expected-revision', 'request-id'],
  claim_show: [], claim_list: ['tool', 'project', 'after', 'limit'],
  claim_acquire: ['incarnation', 'session-id', 'ttl', 'agent-label', 'request-id'],
  claim_renew: ['claim-proof', 'expected-revision', 'ttl', 'request-id'], claim_release: ['claim-proof', 'expected-revision', 'request-id'],
  ready: ['tool', 'project', 'type', 'priority', 'label', 'after', 'limit'], blocked: ['tool', 'project', 'type', 'priority', 'label', 'after', 'limit'],
  memory_create: ['project', 'title', 'body', 'body-file', 'request-id'],
  memory_show: ['project'], memory_list: ['project', 'after', 'limit'], memory_search: ['project', 'after', 'limit'],
  memory_update: ['project', 'title', 'body', 'body-file', 'expected'], memory_delete: ['project', 'expected'],
  memory_context: ['project', 'after', 'limit', 'max-bytes', 'with-revision'],
  agent_install: [], agent_remove: [], agent_context: [],
  connection: ['url'],
  init: ['stealth', 'tool', 'project'], context: [], export: ['file', 'historical'], import: ['file'], actor: [], show: [],
  create: ['tool', 'project', 'body', 'body-file', 'type', 'status', 'priority', 'label', 'parent', 'request-id'],
  comment: ['body', 'body-file'],
  update: ['tool', 'project', 'body', 'body-file', 'type', 'status', 'priority', 'label', 'clear-labels', 'expect', 'force', 'reason', 'claim-proof'],
  close: ['expected', 'force', 'reason', 'claim-proof'], reopen: ['expected', 'claim-proof'],
  list: ['tool', 'project', 'status', 'type', 'priority', 'label', 'after', 'limit'],
  search: ['tool', 'project', 'status', 'type', 'priority', 'label', 'after', 'limit'],
};
for (const command of ['create', 'show', 'list', 'search', 'comment', 'update', 'close', 'reopen']) commandFlags[command] = [...(commandFlags[command] ?? []), 'observed-memory-revision'];
type PrefixSource = 'flag' | 'repository' | 'builtin';
type PrefixOrigin = { prefix: string; prefix_source: PrefixSource };
function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined;
}
function shorthandNotFoundId(error: PolylinedbError): string | undefined {
  if (error.status !== 404) return undefined;
  const details = plainRecord(error.details);
  if (details === undefined) return undefined;
  const keys = Object.keys(details);
  if (error.code === 'not_found' && keys.length === 1 && typeof details.id === 'string') return details.id;
  if (error.code === 'memory_not_found' && keys.length === 2 && typeof details.id === 'string' && typeof details.project === 'string') return details.id;
  return undefined;
}
async function executeWithPrefixOrigin<T>(origins: ReadonlyMap<string, PrefixOrigin>, execute: () => Promise<T>): Promise<T> {
  try { return await execute(); }
  catch (error: unknown) {
    if (!(error instanceof PolylinedbError)) throw error;
    const id = shorthandNotFoundId(error);
    const origin = id === undefined ? undefined : origins.get(id);
    if (origin === undefined) throw error;
    const details = plainRecord(error.details);
    if (details === undefined) throw error;
    throw new PolylinedbError(error.code, error.message, error.status, { ...details, ...origin });
  }
}
function invalid(message: string): never { throw new PolylinedbError('invalid_input', message, 400); }
function writeOperationResult(operation: Operation, result: OperationResult, human: boolean): void {
  if (!human) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  const terminal = { stdoutIsTTY: process.stdout.isTTY, env: process.env };
  if (operation.op === 'show' && 'issue' in result && 'comments' in result) {
    process.stdout.write(renderHumanIssueRead({ command: 'show', result }, terminal) + '\n');
    return;
  }
  if ((operation.op === 'list' || operation.op === 'search') && 'issues' in result && 'next_cursor' in result) {
    process.stdout.write(renderHumanIssueRead({ command: operation.op, result }, terminal) + '\n');
    return;
  }
  throw new Error('Issue read returned an unexpected result shape');
}
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
async function main(argv: readonly string[]): Promise<void> {
  const args = argv;
  if (args.length === 0) {
    process.stdout.write(help);
    return;
  }
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  let optionsEnded = false;
  let human = false;
  let jsonRequested = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (optionsEnded) { positionals.push(arg); continue; }
    if (arg === '--') { optionsEnded = true; continue; }
    if (arg === '--help' || arg === '-h') { process.stdout.write(help); return; }
    if (arg === '--json') { jsonRequested = true; continue; }
    if (arg === '--human') {
      if (human) invalid('Duplicate flag --human');
      human = true;
      continue;
    }
    if (!arg.startsWith('-')) { positionals.push(arg); continue; }
    if (!arg.startsWith('--')) invalid(`Unknown flag ${arg}`);
    const name = arg.slice(2);
    if (![...globals, ...Object.values(commandFlags).flat()].includes(name)) invalid(`Unknown flag ${arg}`);
    const value = ['clear-labels', 'stealth', 'with-revision', 'force', 'historical'].includes(name) ? 'true' : args[++index];
    if (value === undefined || value === '--' || (value.startsWith('--') && value !== '--help')) invalid(`Missing value for ${arg}`);
    const previous = flags.get(name) ?? [];
    if (previous.length && name !== 'label' && name !== 'expect') invalid(`Duplicate flag ${arg}`);
    flags.set(name, [...previous, value]);
  }
  const [first, ...rest] = positionals;
  const nested = first === 'memory' || first === 'snapshot' || first === 'agent' || first === 'dependency' || first === 'claim';
  const command = nested ? `${first}_${rest[0] ?? ''}` : first;
  const operands = nested ? rest.slice(1) : rest;
  if (!command || !Object.hasOwn(commandFlags, command)) invalid('Unknown command');
  if (human && jsonRequested) invalid('--human conflicts with --json');
  if (human && !['show', 'list', 'search'].includes(command)) invalid('--human supports only show, list, and search');
  for (const name of flags.keys()) {
    if (!globals.includes(name) && !commandFlags[command].includes(name)) invalid(`Flag --${name} is not valid for ${command}`);
  }
  const needsOperand = ['show', 'search', 'comment', 'update', 'close', 'reopen', 'memory_show', 'memory_search', 'memory_update', 'memory_delete', 'agent_install', 'agent_remove', 'agent_context', 'dependency_list', 'claim_show', 'claim_acquire'].includes(command);
  if (!['connection', 'auth'].includes(command) && operands.length !== (needsOperand ? 1 : 0)) invalid(`Invalid arguments for ${command}`);
  const one = (name: string) => flags.get(name)?.[0];
  if (command === 'snapshot_convert') {
    if ([...flags.keys()].some(key => !['file', 'output', 'from'].includes(key))) invalid('Snapshot conversion accepts only --file, --output and --from');
    const file = one('file');
    if (file === undefined) invalid('Snapshot conversion requires --file');
    let source: unknown;
    try { source = JSON.parse(await readInput(file, 16 * 1024 * 1024)); }
    catch (error) { if (error instanceof SyntaxError) invalid('Snapshot must contain valid JSON'); throw error; }
    if (one('from') !== undefined && one('from') !== '2' && one('from') !== '3' && one('from') !== '4') invalid('Snapshot --from must be 2, 3 or 4');
    const converted = one('from') === '4' ? convertSnapshotV4(source) : one('from') === '3' ? convertSnapshotV3(source) : convertSnapshotV2(source);
    const content = canonicalSnapshot(converted) + '\n';
    const output = one('output') ?? '-';
    if (output === '-') process.stdout.write(content);
    else {
      await writeFile(output, content, { flag: 'wx', mode: 0o600 });
      process.stdout.write(JSON.stringify({ file: output, version: 5, sha256: createHash('sha256').update(canonicalSnapshot(converted)).digest('hex') }) + '\n');
    }
    return;
  }
  if (command.startsWith('agent_')) {
    if ([...flags.keys()].some(name => globals.includes(name))) invalid('Agent hook commands do not accept connection selectors');
    const host = parseAgentHost(operands[0]);
    if (command === 'agent_install') process.stdout.write(JSON.stringify(installAgentHost(host)) + '\n');
    else if (command === 'agent_remove') process.stdout.write(JSON.stringify(removeAgentHost(host)) + '\n');
    else {
      let input = '';
      try { input = await readInput('-', 1024 * 1024); } catch { }
      process.stdout.write(JSON.stringify(agentContext(host, input)) + '\n');
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
  const explicitPrefix = one('prefix');
  const prefixSource: PrefixSource = explicitPrefix !== undefined ? 'flag' : defaults !== undefined ? 'repository' : 'builtin';
  const prefix = parseArgument(parsePrefix, explicitPrefix ?? defaults?.prefix ?? 'pd');
  const prefixOrigin: PrefixOrigin = { prefix, prefix_source: prefixSource };
  const shorthandOrigins = new Map<string, PrefixOrigin>();
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
  if (selected.kind === 'local' && ['create', 'comment', 'update', 'close', 'reopen', 'import', 'upgrade', 'memory_create', 'memory_update', 'memory_delete', 'dependency_add', 'dependency_remove', 'claim_acquire', 'claim_renew', 'claim_release'].includes(command) && one('actor') === undefined && !process.env.POLYLINEDB_ACTOR && !defaults?.actor) invalid('An explicit --actor, POLYLINEDB_ACTOR, or repository actor is required');
  if (command === 'upgrade') {
    if (selected.kind !== 'local') invalid('Use the documented operator procedure to upgrade D1');
    process.stdout.write(JSON.stringify(upgradeStore({ directory: selected.directory })) + '\n');
    return;
  }
  if (selected.kind === 'local' && command === 'actor') { process.stdout.write(JSON.stringify({ actor }) + '\n'); return; }
  if (command === 'import' || command === 'export') {
    if (selected.kind === 'cloud') throw new PolylinedbError('cloud_snapshot_not_supported', 'Import and export require a local connection. Use the documented D1 migration procedure for cloud data.', 400);
    const directory = selected.directory;
    if (command === 'export' && flags.has('historical')) {
      const exported = exportHistoricalSnapshot({ directory }); const file = one('file') ?? '-'; const content = JSON.stringify(exported, null, 2) + '\n';
      if (file === '-') process.stdout.write(content);
      else { await writeFile(file, content, { flag: 'wx', mode: 0o600 }); process.stdout.write(JSON.stringify({ file, sha256: createHash('sha256').update(canonicalSnapshot(exported)).digest('hex') }) + '\n'); }
      return;
    }
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
    const expandedMemory = (value: string, trackForNotFound = true) => {
      const shorthand = /^(?:m)?[1-9][0-9]*$/.test(value);
      const id = parseMemoryId(shorthand ? `${prefix}-m${value.replace(/^m/, '')}` : value);
      if (shorthand && trackForNotFound) shorthandOrigins.set(id, prefixOrigin);
      return id;
    };
    raw.project = project;
    if (flags.has('with-revision')) raw.with_revision = true;
    if (needsOperand) raw[command === 'memory_search' ? 'query' : 'id'] = command === 'memory_search' ? operands[0] : expandedMemory(operands[0]);
    if (one('body') !== undefined && one('body-file') !== undefined) invalid('Use either --body or --body-file');
    for (const key of ['title', 'body']) if (one(key) !== undefined) raw[key] = one(key);
    const file = one('body-file');
    if (file !== undefined) raw.body = await readInput(file, 16384);
    for (const key of ['limit', 'expected', 'max-bytes']) { const value = one(key); if (value !== undefined) raw[key.replace('-', '_')] = integer(value); }
    const after = one('after');
    if (after !== undefined) raw.after = expandedMemory(after, false);
    if (command === 'memory_create') { raw.prefix = prefix; raw.request_id = one('request-id') ?? randomUUID(); }
    const operation = parseOperation(raw);
    if (selected.kind === 'cloud') writeOperationResult(operation,
      await executeWithPrefixOrigin(shorthandOrigins, () => createCloudClient(selected).execute(operation)), human);
    else {
      if (actor === undefined) invalid('Local connection requires an actor');
      const store = openStore({ directory: selected.directory });
      try { writeOperationResult(operation,
        await executeWithPrefixOrigin(shorthandOrigins, () => executeOperation(store.db, operation, actor, { kind: 'local', database_path: join(selected.directory, 'polylinedb.sqlite') })), human); }
      finally { store.close(); }
    }
    return;
  }
  const expandedId = (value: string, trackForNotFound = true) => {
    const shorthand = /^[0-9]+(?:\.[0-9]+)*$/.test(value);
    const id = parseArgument(parseIssueId, shorthand ? `${prefix}-${value}` : value);
    if (shorthand && trackForNotFound) shorthandOrigins.set(id, prefixOrigin);
    return id;
  };
  if (one('observed-memory-revision') !== undefined) raw.observed_memory_revision = one('observed-memory-revision');
  if (needsOperand) raw[command === 'search' ? 'query' : command === 'dependency_list' ? 'dependent_id' : command === 'claim_show' || command === 'claim_acquire' ? 'issue_id' : 'id'] = command === 'search' ? operands[0] : expandedId(operands[0]);
  const proof = one('claim-proof');
  if (proof !== undefined) {
    if (new TextEncoder().encode(proof).length > 1024) invalid('Claim proof exceeds 1024 UTF-8 bytes');
    try { raw.claim_proof = JSON.parse(proof); } catch { invalid('Claim proof must contain valid JSON'); }
  }
  if (command === 'claim_acquire') {
    raw.incarnation = one('incarnation'); raw.session_id = one('session-id') ?? process.env.POLYLINEDB_SESSION_ID;
    if (one('agent-label') !== undefined) raw.agent_label = one('agent-label');
    raw.request_id = one('request-id') ?? randomUUID();
  }
  if (command === 'claim_renew' || command === 'claim_release') {
    raw.request_id = one('request-id') ?? randomUUID(); const expected = one('expected-revision');
    if (expected !== undefined) raw.expected_revision = integer(expected);
  }
  const ttl = one('ttl'); if (ttl !== undefined) raw.ttl = integer(ttl);
  if (command === 'ready' || command === 'blocked') { raw.op = 'dependency_worklist'; raw.state = command; }
  if (command === 'dependency_add' || command === 'dependency_remove') {
    const dependent = one('dependent'); const blocker = one('blocker'); const expected = one('expected-revision');
    if (dependent === undefined || blocker === undefined || expected === undefined) invalid('Dependency mutation requires --dependent, --blocker and --expected-revision');
    raw.dependent_id = expandedId(dependent); raw.blocker_id = expandedId(blocker); raw.expected_revision = integer(expected);
    raw.request_id = one('request-id') ?? randomUUID();
  }
  if (flags.has('force')) raw.force = true;
  if (one('reason') !== undefined) raw.reason = one('reason');
  if (one('body') !== undefined && one('body-file') !== undefined) invalid('Use either --body or --body-file');
  const bodyFile = one('body-file');
  let body = one('body');
  if (bodyFile !== undefined) {
    body = await readInput(bodyFile, 65536);
  }
  for (const name of ['tool', 'project', 'status', 'type']) if (one(name) !== undefined) raw[name] = one(name);
  for (const name of ['parent', 'after']) {
    const value = one(name);
    if (value !== undefined) raw[name] = expandedId(value, name === 'parent');
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
  const filtered = ['list', 'search', 'ready', 'blocked'].includes(command);
  if (flags.has('label')) raw[filtered ? 'label' : 'labels'] = filtered ? one('label') : flags.get('label');
  if (filtered && (flags.get('label')?.length ?? 0) > 1) invalid('Filter --label is a singleton');
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
    writeOperationResult(operation,
      await executeWithPrefixOrigin(shorthandOrigins, () => createCloudClient(selected).execute(operation)), human);
    return;
  }
  if (actor === undefined) invalid('Local connection requires an actor');
  const store = openStore({ directory: selected.directory });
  try { writeOperationResult(operation,
    await executeWithPrefixOrigin(shorthandOrigins, () => executeOperation(store.db, operation, actor, { kind: 'local', database_path: join(selected.directory, 'polylinedb.sqlite') })), human); }
  finally { store.close(); }
}
export async function runCli(argv: readonly string[]): Promise<void> {
  try { await main(argv); }
  catch (error: unknown) {
    const known = error instanceof PolylinedbError;
    const authentication = error instanceof OAuthError || error instanceof CredentialStoreError;
    process.stderr.write(JSON.stringify({ error: { code: known || authentication ? error.code : 'internal_error', message: error instanceof Error ? error.message : 'Internal error', ...(known && error.details !== undefined ? { details: error.details } : {}) } }) + '\n');
    process.exitCode = known ? ({ 400: 2, 404: 3, 409: 4 }[error.status] ?? 1) : 1;
  }
}
