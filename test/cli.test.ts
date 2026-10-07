// Subprocesses verify the executable contract against real persistent storage.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { retireSource } from '../scripts/d1-additive-merge.ts';
import { openStore } from '../src/local-store/index.ts';

const executable = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
function isolatedEnvironment(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_CONFIG_HOME: join(cwd, '..', 'config-home') };
  delete env.POLYLINEDB_ACTOR;
  delete env.POLYLINEDB_ACTOR_KIND;
  delete env.POLYLINEDB_DATA_DIR;
  delete env.POLYLINEDB_CONNECTION;
  delete env.POLYLINEDB_SESSION_ID;
  return env;
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'polylinedb-cli-'));
  const cwd = join(root, 'work');
  const directory = join(root, 'store');
  mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function run(args: string[], options: { status?: number; input?: string; actor?: boolean; env?: NodeJS.ProcessEnv; raw?: boolean } = {}) {
    const env = { ...isolatedEnvironment(cwd), ...options.env };
    const result = spawnSync(process.execPath, [executable, '--data-dir', directory, ...(options.actor === false ? [] : ['--actor', 'local:test']), ...args], {
      cwd, encoding: 'utf8', input: options.input,
      env,
    });
    assert.equal(result.status, options.status ?? 0, result.stderr);
    const output = result.status === 0 ? result.stdout : result.stderr;
    assert.equal(result.status === 0 ? result.stderr.replace(/^.*ExperimentalWarning.*\n(?:.*\n)?/gm, '') : result.stdout, '');
    return options.raw ? result.stdout : JSON.parse(output);
  }
  return { root, cwd, directory, run };
}
function retire(directory: string, connectionName = 'archive'): DatabaseSync {
  const database = new DatabaseSync(join(directory, 'polylinedb.sqlite'));
  try {
    database.exec('BEGIN IMMEDIATE');
    retireSource(database, connectionName);
    database.exec('COMMIT');
    return database;
  } catch (error) { database.close(); throw error; }
}

test('CLI persists issues, exposes conflicts, and appends comments', t => {
  const { run, cwd } = fixture(t);
  const initialized = run(['init']);
  assert.deepEqual(run(['init']), initialized);
  assert.deepEqual(readdirSync(cwd), []);
  const { issue } = run(['create', '--tool', 'codex', '--project', 'demo', '--body-file', '-', '--label', 'urgent', '--json'], { input: 'first body\n' });
  assert.equal(issue.body, 'first body\n');
  assert.equal(issue.created_by, 'local:test');
  assert.deepEqual(run(['show', issue.id]).issue, issue);
  const changed = run(['update', issue.id, '--body', 'new body', '--expect', 'body=1']).issue;
  assert.equal(changed.versions.body, 2);
  const stale = run(['update', issue.id, '--body', 'stale', '--expect', 'body=1'], { status: 4 });
  assert.equal(stale.error.code, 'conflict');
  assert.equal(run(['update', issue.id, '--priority', '0', '--expect', 'priority=1']).issue.priority, 0);
  const comment = run(['comment', issue.id, '--body', 'needle comment']).comment;
  assert.equal(comment.body, 'needle comment');
  assert.equal(run(['show', issue.id]).comments.length, 1);
  assert.equal(run(['search', 'needle']).issues[0].id, issue.id);
  assert.equal(run(['list', '--label', 'urgent', '--tool', 'codex']).issues.length, 1);
  assert.equal(run(['close', issue.id, '--expected', '1']).issue.status, 'closed');
  assert.equal(run(['reopen', issue.id, '--expected', '2']).issue.status, 'open');
  assert.deepEqual(run(['show', '48'], { status: 3 }).error, {
    code: 'not_found', message: 'Issue was not found',
    details: { id: 'pd-48', prefix: 'pd', prefix_source: 'builtin' },
  });
  assert.deepEqual(run(['--prefix', 'alt', 'comment', '49', '--body', 'missing'], { status: 3 }).error, {
    code: 'not_found', message: 'Issue was not found',
    details: { id: 'alt-49', prefix: 'alt', prefix_source: 'flag' },
  });
  assert.deepEqual(run(['create', '--tool', 'codex', '--project', 'demo', '--body', 'child', '--parent', '50'], { status: 3 }).error, {
    code: 'not_found', message: 'Issue was not found',
    details: { id: 'pd-50', prefix: 'pd', prefix_source: 'builtin' },
  });
  assert.deepEqual(run(['show', 'pd-51'], { status: 3 }).error, {
    code: 'not_found', message: 'Issue was not found', details: { id: 'pd-51' },
  });
});
test('CLI human reads show full details and comments, safe previews, and page cursors', t => {
  const { run } = fixture(t);
  run(['init']);
  const body = 'Control ESC:\u001b[31m C1:\u0085 DEL:\u007f LS:\u2028 PS:\u2029\n入力';
  const { issue } = run(['create', '--tool', 'editor', '--project', 'parser', '--body', body]);
  run(['comment', issue.id, '--body', '確認しました。\n次へ進みます。']);
  const second = run(['create', '--tool', 'editor', '--project', 'parser', '--body', 'Second issue']).issue;

  const details = run(['show', issue.id, '--human'], { raw: true });
  assert.match(details, /^Issue details\nID pd-1\nStatus open\n/);
  assert.ok(details.includes('Project parser\nLabels (none)\n'));
  assert.ok(details.includes('Body\n  Control ESC:\\u001B[31m C1:\\u0085 DEL:\\u007F LS:\\u2028 PS:\\u2029\n  入力\nComments (1)\n'));
  assert.ok(details.includes('    確認しました。\n    次へ進みます。'));
  assert.equal(details.endsWith('\n'), true);
  assert.equal(details.endsWith('\n\n'), false);
  assert.equal(details.includes('\u001b'), false);

  const firstPage = run(['list', '--limit', '1', '--human'], { raw: true });
  assert.ok(firstPage.startsWith('Issues\npd-1  open  P2  task\n'));
  assert.ok(firstPage.includes('  Project: parser · Tool: editor\n'));
  assert.ok(firstPage.includes('  Body: Control ESC:\\u001B[31m C1:\\u0085 DEL:\\u007F LS:'));
  assert.ok(firstPage.endsWith('\n  pd-1\n'));
  assert.ok(firstPage.includes('More results. Use this value with --after.'));
  const nextPage = run(['list', '--human', '--limit', '1', '--after', 'pd-1'], { raw: true });
  assert.ok(nextPage.startsWith(`Issues\n${second.id}  open  P2  task\n`));
  assert.ok(nextPage.endsWith('\nEnd of results.\n'));
  const matches = run(['search', 'Second issue', '--human'], { raw: true });
  assert.ok(matches.startsWith(`Search matches\n${second.id}  open  P2  task\n`));

  const literalAfterTerminator = run(['search', '--', '--human'], { raw: true });
  assert.deepEqual(JSON.parse(literalAfterTerminator).issues, []);
  assert.deepEqual(run(['show', '99', '--human'], { status: 3 }), {
    error: { code: 'not_found', message: 'Issue was not found', details: { id: 'pd-99', prefix: 'pd', prefix_source: 'builtin' } },
  });
  assert.deepEqual(run(['show', issue.id]), run(['--json', 'show', issue.id]));
});
test('CLI rejects unsupported human commands and explicit JSON before opening a store', t => {
  const { run, directory } = fixture(t);
  const unsupported = [
    ['context', '--human'],
    ['auth', 'status', '--human'],
    ['memory', 'context', '--project', 'parser', '--human'],
    ['agent', 'context', 'claude', '--human'],
    ['snapshot', 'convert', '--human'],
    ['claim', 'show', '1', '--human'],
    ['ready', '--human'],
    ['blocked', '--human'],
    ['create', '--tool', 'editor', '--project', 'parser', '--body', 'New issue', '--human'],
  ];
  for (const args of unsupported) {
    const result = run(args, { status: 2 });
    assert.deepEqual(result.error, {
      code: 'invalid_input', message: '--human supports only show, list, and search',
    });
  }
  for (const args of [
    ['show', '1', '--human', '--json'],
    ['--json', 'show', '1', '--human'],
  ]) {
    const result = run(args, { status: 2 });
    assert.deepEqual(result.error, { code: 'invalid_input', message: '--human conflicts with --json' });
  }
  assert.equal(existsSync(directory), false);
});
test('CLI claim sessions, observed incarnation, proof JSON, CAS and immutable retries agree', t => {
  const { run } = fixture(t); run(['init']); run(['create', '--tool', 'test', '--project', 'test', '--body', 'Claim']);
  const inspected = run(['claim', 'show', '1']).claim; assert.equal(inspected.state, 'never_claimed');
  const session = crypto.randomUUID(); const request = crypto.randomUUID();
  const args = ['claim', 'acquire', '1', '--incarnation', inspected.store_incarnation, '--request-id', request, '--agent-label', 'Codex'];
  const acquired = run(args, { env: { POLYLINEDB_SESSION_ID: session } }); const receipt = acquired.claim_receipt; assert.equal(receipt.session_id, session); assert.equal(receipt.agent_label, 'Codex'); assert.equal(receipt.expires_at - receipt.changed_at, 300);
  const proof = JSON.stringify({ issue_id: receipt.issue_id, incarnation: receipt.incarnation, session_id: receipt.session_id, generation: receipt.generation });
  assert.equal(run(['close', '1', '--expected', '1', '--force', '--reason', 'Exception'], { status: 4 }).error.code, 'claim_required');
  assert.equal(run(['update', '1', '--body', 'Changed', '--status', 'in_progress', '--expect', 'body=1', '--expect', 'status=1', '--claim-proof', proof]).issue.versions.status, 2);
  assert.equal(run(['claim', 'renew', '--claim-proof', proof, '--expected-revision', '1', '--ttl', '30']).claim_receipt.revision, 2);
  assert.deepEqual(run([...args, '--session-id', session]), acquired);
  assert.equal(run(['claim', 'release', '--claim-proof', proof, '--expected-revision', '2']).claim_receipt.outcome, 'released');
  assert.equal(run(['claim', 'show', 'pd-1']).claim.state, 'released');
  assert.equal(run(['claim', 'list', '--project', 'test']).claims[0].lease.agent_label, 'Codex');
  assert.equal(run(['close', '1', '--expected', '2', '--claim-proof', proof], { status: 4 }).error.code, 'claim_required');
  const second = run(['claim', 'acquire', '1', '--incarnation', inspected.store_incarnation, '--session-id', crypto.randomUUID()]).claim_receipt;
  const secondProof = JSON.stringify({ issue_id: second.issue_id, incarnation: second.incarnation, session_id: second.session_id, generation: second.generation });
  assert.equal(second.generation, 2); assert.equal(second.revision, 4);
  assert.equal(run(['close', '1', '--expected', '2', '--claim-proof', secondProof]).issue.status, 'closed');
  assert.equal(run(['reopen', '1', '--expected', '3', '--claim-proof', secondProof]).issue.status, 'open');
});
test('CLI rejects claim flags and malformed proof before opening storage', t => {
  const { run, directory } = fixture(t);
  for (const args of [
    ['init', '--session-id', crypto.randomUUID()], ['claim', 'show', '1', '--ttl', '30'],
    ['claim', 'acquire', '1', '--incarnation', 'f'.repeat(32)],
    ['claim', 'renew', '--claim-proof', '{', '--expected-revision', '1'],
    ['close', '1', '--expected', '1', '--claim-proof', '{}'], ['claim', 'unknown'],
  ]) assert.equal(run(args, { status: 2 }).error.code, 'invalid_input');
  assert.equal(existsSync(directory), false);
});
test('CLI requires an explicit actor before parsing mutation payloads or opening storage', t => {
  const { run, directory } = fixture(t);
  assert.deepEqual(run(['comment'], { actor: false, status: 2 }).error, {
    code: 'invalid_input', message: 'Invalid arguments for comment',
  });
  assert.equal(existsSync(directory), false);
  const mutations = [
    ['create'], ['comment', 'pd-1'], ['update', 'pd-1'], ['close', 'pd-1'], ['reopen', 'pd-1'],
    ['memory', 'create'], ['memory', 'update', 'pd-m1'], ['memory', 'delete', 'pd-m1'],
    ['dependency', 'add'], ['dependency', 'remove'],
    ['claim', 'acquire', 'pd-1'], ['claim', 'renew'], ['claim', 'release'],
    ['import'], ['upgrade'],
  ];
  for (const args of mutations) {
    assert.deepEqual(run(args, { actor: false, status: 2 }).error, {
      code: 'invalid_input', message: 'An explicit --actor, POLYLINEDB_ACTOR, or repository actor is required',
    });
    assert.equal(existsSync(directory), false);
  }
});
test('CLI ready and blocked retain local reader fallback, and unknown commands reach command validation', t => {
  const { run } = fixture(t);
  run(['init'], { actor: false });
  run(['create', '--tool', 'test', '--project', 'test', '--body', 'Ready issue']);
  assert.deepEqual(run(['ready'], { actor: false }).issues.map((issue: { id: string }) => issue.id), ['pd-1']);
  assert.deepEqual(run(['blocked'], { actor: false }).issues, []);
  assert.deepEqual(run(['not_an_operation'], { actor: false, status: 2 }).error, {
    code: 'invalid_input', message: 'Unknown command',
  });
});
for (const command of ['acquire', 'renew', 'release']) test(`CLI local claim ${command} requires an explicit actor and preserves both claim tables on rejection`, t => {
  const { run, directory } = fixture(t); run(['init'], { actor: false }); run(['create', '--tool', 'test', '--project', 'test', '--body', 'Actor admission']);
  const incarnation = run(['claim', 'show', '1'], { actor: false }).claim.store_incarnation;
  const acquire = ['claim', 'acquire', '1', '--incarnation', incarnation, '--session-id', crypto.randomUUID()];
  let args = acquire;
  if (command !== 'acquire') {
    const owner = run(acquire, { actor: false, env: { POLYLINEDB_ACTOR: 'local:reader' } }).claim_receipt;
    const proof = JSON.stringify({ issue_id: owner.issue_id, incarnation: owner.incarnation, session_id: owner.session_id, generation: owner.generation });
    args = ['claim', command, '--claim-proof', proof, '--expected-revision', '1'];
  }
  const database = new DatabaseSync(join(directory, 'polylinedb.sqlite'));
  try {
    const before = ['issue_claims', 'claim_requests'].map(table => database.prepare(`SELECT * FROM ${table}`).all());
    const rejected = run(args, { actor: false, status: 2 }); assert.equal(rejected.error.code, 'invalid_input'); assert.match(rejected.error.message, /explicit.*actor/);
    assert.deepEqual(['issue_claims', 'claim_requests'].map(table => database.prepare(`SELECT * FROM ${table}`).all()), before);
    const accepted = run(args, { actor: false, env: { POLYLINEDB_ACTOR: 'local:reader' } }).claim_receipt;
    assert.equal(accepted.actor, 'local:reader'); assert.equal(accepted.outcome, command === 'acquire' ? 'acquired' : command === 'renew' ? 'renewed' : 'released');
  } finally { database.close(); }
});
test('CLI claim mutations accept the explicitly configured repository actor', t => {
  const { run, cwd } = fixture(t); execFileSync('git', ['init', '--quiet', cwd], { env: isolatedEnvironment(cwd) });
  run(['--actor', 'local:repository', 'init', '--tool', 'test', '--project', 'test'], { actor: false });
  run(['create', '--body', 'Repository actor'], { actor: false });
  const incarnation = run(['claim', 'show', '1'], { actor: false }).claim.store_incarnation;
  const owner = run(['claim', 'acquire', '1', '--incarnation', incarnation, '--session-id', crypto.randomUUID()], { actor: false }).claim_receipt;
  assert.equal(owner.actor, 'local:repository');
  const proof = JSON.stringify({ issue_id: owner.issue_id, incarnation: owner.incarnation, session_id: owner.session_id, generation: owner.generation });
  assert.equal(run(['claim', 'renew', '--claim-proof', proof, '--expected-revision', '1'], { actor: false }).claim_receipt.actor, 'local:repository');
  assert.equal(run(['claim', 'release', '--claim-proof', proof, '--expected-revision', '2'], { actor: false }).claim_receipt.actor, 'local:repository');
});

test('CLI rejects invalid arguments before creating storage and actor requires no store', t => {
  const { run, root, cwd } = fixture(t);
  assert.deepEqual(run(['actor'], { actor: false }), { actor: 'local:reader' });
  assert.equal(run(['create', '--tool', 'codex', '--project', 'demo', '--body', 'x'], { status: 2, actor: false }).error.code, 'invalid_input');
  for (const args of [
    ['init', '--unknown'], ['init', '--data-dir'], ['list', '--limit', '1', '--limit', '2'],
    ['show', 'one', 'two'], ['list', '--priority', '1.0'], ['list', '--priority', '-1'],
    ['update', 'id', '--body', 'x'], ['update', 'id', '--body', 'x', '--expect', 'boddy=1'],
    ['update', 'id', '--body', 'x', '--expect', 'body=1', '--expect', 'status=1'],
    ['create', '--tool', 'c', '--project', 'p', '--body', 'x', '--body-file', '-'],
  ]) assert.equal(run(args, { status: 2 }).error.code, 'invalid_input');
  assert.deepEqual(readdirSync(root), ['work']);
  assert.deepEqual(readdirSync(cwd), []);
});

test('CLI prevents repository and symlink storage paths', t => {
  const { root, cwd } = fixture(t);
  mkdirSync(join(cwd, '.git'));
  const alias = join(root, 'alias');
  symlinkSync(cwd, alias);
  for (const directory of [join(cwd, 'state'), join(alias, 'state')]) {
    const result = spawnSync(process.execPath, [executable, 'init', '--data-dir', directory], { cwd, env: isolatedEnvironment(cwd), encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(result.status, 2);
    assert.deepEqual(JSON.parse(result.stderr).error, {
      code: 'invalid_data_directory', message: 'The data directory must be outside the working directory and Git repositories',
      details: { rule: 'working_directory' },
    });
  }
  assert.deepEqual(readdirSync(cwd), ['.git']);
});

test('CLI identifies repository data-directory rejections without exposing paths', t => {
  const { root, cwd } = fixture(t);
  git(root, ['init', '--quiet']);
  const configRoot = mkdtempSync(join(tmpdir(), 'polylinedb-cli-config-'));
  const otherRoot = mkdtempSync(join(tmpdir(), 'polylinedb-other-checkout-'));
  t.after(() => rmSync(configRoot, { recursive: true, force: true }));
  t.after(() => rmSync(otherRoot, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: join(configRoot, 'config') };
  const siblingStore = join(root, 'sibling-store');
  const sibling = plainCli(cwd, ['--data-dir', siblingStore, 'show', '1'], { status: 2, env }).error;
  assert.deepEqual(sibling, {
    code: 'invalid_data_directory', message: 'The data directory must be outside the working directory and Git repositories',
    details: { rule: 'git_repository' },
  });

  mkdirSync(join(otherRoot, '.git'));
  const checkout = plainCli(cwd, ['--data-dir', join(otherRoot, 'store'), 'show', '1'], { status: 2, env }).error;
  assert.deepEqual(checkout, {
    code: 'invalid_data_directory', message: 'The data directory must be outside the working directory and Git repositories',
    details: { rule: 'git_repository' },
  });
});

test('CLI treats dash queries and help option values as literal text', t => {
  const { run } = fixture(t);
  run(['init']);
  const compiler = run(['create', '--tool', 'codex', '--project', 'demo', '--body', 'Fix -Werror']).issue;
  const helpText = run(['create', '--tool', 'codex', '--project', 'demo', '--body', '--help']).issue;
  assert.equal(helpText.body, '--help');
  assert.deepEqual(run(['search', '--', '-Werror']).issues.map((issue: { id: string }) => issue.id), [compiler.id]);
  assert.deepEqual(run(['search', '--', '--help']).issues.map((issue: { id: string }) => issue.id), [helpText.id]);
  assert.equal(run(['update', helpText.id, '--body', '--help', '--expect', 'body=1']).issue.body, '--help');
  assert.equal(run(['comment', helpText.id, '--body', '--help']).comment.body, '--help');
});

test('help documents version expectations without initializing storage', t => {
  const { root, cwd, directory } = fixture(t);
  const result = spawnSync(process.execPath, [executable, '--data-dir', directory, '--help'], { cwd, env: isolatedEnvironment(cwd), encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--expected VERSION/);
  assert.match(result.stdout, /--expect FIELD=VERSION/);
  assert.match(result.stdout, /--human for successful show, list and search reads/);
  assert.match(result.stdout, /plain on pipes/);
  for (const args of [['search', '--help'], ['-h'], []]) {
    const helpResult = spawnSync(process.execPath, [executable, ...args], { cwd, env: isolatedEnvironment(cwd), encoding: 'utf8' });
    assert.equal(helpResult.status, 0);
    assert.equal(helpResult.stdout, result.stdout);
  }
  assert.deepEqual(readdirSync(root), ['work']);
});

function plainCli(cwd: string, args: string[], options: { status?: number; input?: string; env?: Record<string, string> } = {}) {
  const env = isolatedEnvironment(cwd);
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd, env: { ...env, ...options.env }, encoding: 'utf8', input: options.input,
  });
  assert.equal(result.status, options.status ?? 0, result.stderr);
  if (result.status === 0) assert.equal(result.stderr.replace(/^.*ExperimentalWarning.*\n(?:.*\n)?/gm, ''), '');
  else assert.equal(result.stdout, '');
  return JSON.parse(result.status === 0 ? result.stdout : result.stderr);
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('CLI reports repository prefix provenance for a missing numeric shorthand', t => {
  const { root, cwd, directory } = fixture(t);
  git(cwd, ['init', '--quiet']);
  plainCli(cwd, ['init', '--stealth', '--data-dir', directory, '--tool', 'demo', '--project', 'demo', '--actor', 'local:owner', '--prefix', 'repo']);
  const failure = plainCli(cwd, ['show', '48'], { status: 3 }).error;
  assert.deepEqual(failure, {
    code: 'not_found', message: 'Issue was not found',
    details: { id: 'repo-48', prefix: 'repo', prefix_source: 'repository' },
  });
  assert.deepEqual(readdirSync(cwd), ['.git']);
});

test('stealth init supplies external storage and defaults without changing Git status', t => {
  const { root, cwd } = fixture(t);
  git(cwd, ['init', '--quiet']);
  const before = git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  const env = { XDG_DATA_HOME: join(root, 'data-home') };
  const initialized = plainCli(cwd, ['init', '--stealth', '--tool', 'demo', '--project', 'demo', '--actor', 'local:owner'], { env });
  assert.ok(initialized.database_path.startsWith(join(realpathSync(root), 'data-home', 'polylinedb', 'stores') + '/'));
  assert.equal(initialized.config_path, join(realpathSync(cwd), '.git', 'polylinedb.json'));
  assert.equal(statSync(initialized.config_path).mode & 0o777, 0o600);
  const context = plainCli(cwd, ['context'], { env });
  assert.deepEqual(context, {
    mode: 'local', connection: null, source: 'repository',
    data_dir: initialized.database_path.slice(0, -'/polylinedb.sqlite'.length), database_path: initialized.database_path,
    actor: 'local:owner', tool: 'demo', project: 'demo', prefix: 'pd', config_path: initialized.config_path,
  });
  const { issue } = plainCli(cwd, ['create', '--body', 'Uses repository defaults'], { env });
  assert.equal(issue.tool, 'demo');
  assert.equal(issue.project, 'demo');
  assert.equal(issue.created_by, 'local:owner');
  const other = plainCli(cwd, ['create', '--tool', 'manual-tool', '--project', 'other-project', '--body', 'Explicit overrides'], { env }).issue;
  assert.equal(other.tool, 'manual-tool');
  assert.equal(other.project, 'other-project');
  assert.deepEqual(plainCli(cwd, ['list'], { env }).issues.map((row: { id: string }) => row.id).sort(), [issue.id, other.id].sort());
  assert.deepEqual(plainCli(cwd, ['init', '--stealth'], { env }), initialized);
  assert.equal(git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']), before);
  assert.deepEqual(readdirSync(cwd), ['.git']);
});

test('CLI flags override environment and environment overrides repository actor and store', t => {
  const { root, cwd, directory } = fixture(t);
  git(cwd, ['init', '--quiet']);
  plainCli(cwd, ['init', '--stealth', '--data-dir', directory, '--tool', 'repo-tool', '--project', 'repo-project', '--actor', 'local:repo']);
  const envDirectory = join(root, 'env-store');
  const flagDirectory = join(root, 'flag-store');
  const outside = join(root, 'outside');
  mkdirSync(outside);
  plainCli(outside, ['init', '--data-dir', envDirectory], { env: { XDG_CONFIG_HOME: join(root, 'config-home') } });
  plainCli(outside, ['init', '--data-dir', flagDirectory], { env: { XDG_CONFIG_HOME: join(root, 'config-home') } });
  const env = { POLYLINEDB_DATA_DIR: envDirectory, POLYLINEDB_ACTOR: 'local:env' };
  const environment = plainCli(cwd, ['create', '--body', 'Environment target'], { env }).issue;
  assert.equal(environment.created_by, 'local:env');
  const flagged = plainCli(cwd, ['--data-dir', flagDirectory, '--actor', 'local:flag', 'create', '--tool', 'flag-tool', '--project', 'flag-project', '--body', 'Explicit target'], { env }).issue;
  assert.equal(flagged.created_by, 'local:flag');
  assert.equal(flagged.tool, 'flag-tool');
  assert.equal(flagged.project, 'flag-project');
  assert.equal(plainCli(cwd, ['context'], { env }).data_dir, envDirectory);
  assert.equal(plainCli(cwd, ['context'], { env }).actor, 'local:env');
  assert.equal(plainCli(cwd, ['context', '--data-dir', flagDirectory, '--actor', 'local:flag'], { env }).actor, 'local:flag');
  assert.deepEqual(plainCli(cwd, ['list']).issues, []);
  assert.deepEqual(plainCli(cwd, ['list'], { env }).issues.map((row: { id: string }) => row.id), [environment.id]);
  assert.deepEqual(plainCli(cwd, ['list', '--data-dir', flagDirectory], { env }).issues.map((row: { id: string }) => row.id), [flagged.id]);
});

test('stealth init outside Git rejects before creating a database', t => {
  const { cwd, directory } = fixture(t);
  const result = plainCli(cwd, ['init', '--stealth', '--data-dir', directory, '--actor', 'local:owner', '--tool', 'tool', '--project', 'project'], { status: 2 });
  assert.equal(result.error.code, 'invalid_input');
  assert.equal(existsSync(directory), false);
});

test('CLI snapshot restores IDs, hierarchy, comments, audit and versions with safe rerun', t => {
  const { root, cwd, run } = fixture(t);
  run(['init']);
  const parent = run(['create', '--tool', 'tool', '--project', 'project', '--type', 'epic', '--body', 'Parent']).issue;
  const child = run(['create', '--tool', 'tool', '--project', 'project', '--parent', parent.id, '--body', 'Child', '--label', 'selected']).issue;
  run(['update', child.id, '--body', 'Revised child', '--expect', 'body=1']);
  run(['comment', child.id, '--body', 'Original comment']);
  const source = run(['export']);
  const destination = join(root, 'restored');
  const target = (args: string[], options: { status?: number; input?: string } = {}) => plainCli(cwd, ['--data-dir', destination, '--actor', 'local:restorer', ...args], options);
  target(['init']);
  const imported = target(['import', '--file', '-'], { input: JSON.stringify(source) });
  assert.equal(imported.result, 'imported');
  assert.equal(imported.issues, 2);
  assert.equal(imported.comments, 1);
  assert.deepEqual(target(['export']), source);
  const repeated = target(['import', '--file', '-'], { input: JSON.stringify(source) });
  assert.deepEqual(repeated, { ...imported, result: 'already_present' });
  assert.equal(target(['show', child.id]).comments[0].body, 'Original comment');
  assert.equal(target(['show', child.id]).issue.versions.body, 2);
  target(['update', child.id, '--priority', '0', '--expect', 'priority=1']);
  const changed = target(['export']);
  const rejected = target(['import', '--file', '-'], { input: JSON.stringify(source), status: 4 });
  assert.equal(rejected.error.code, 'destination_not_empty');
  assert.deepEqual(target(['export']), changed);
});

test('malformed and oversized CLI imports leave the initialized store unchanged', t => {
  const { root, run } = fixture(t);
  run(['init']);
  const before = run(['export']);
  const malformed = run(['import', '--file', '-'], { input: '{not JSON', status: 2 });
  assert.equal(malformed.error.code, 'invalid_input');
  assert.deepEqual(run(['export']), before);
  const invalid = run(['import', '--file', '-'], { input: JSON.stringify({ ...before, issues: [{ id: 'invalid' }] }), status: 2 });
  assert.equal(invalid.error.code, 'invalid_snapshot');
  assert.deepEqual(run(['export']), before);
  const oversizedFile = join(root, 'oversized.json');
  writeFileSync(oversizedFile, ' '.repeat(16 * 1024 * 1024 + 1));
  const oversized = run(['import', '--file', oversizedFile], { status: 2 });
  assert.equal(oversized.error.code, 'invalid_input');
  assert.deepEqual(run(['export']), before);
});

test('CLI file export is private and refuses to overwrite an existing snapshot', t => {
  const { root, run } = fixture(t);
  run(['init']);
  run(['create', '--tool', 'tool', '--project', 'project', '--body', 'Export body']);
  const file = join(root, 'snapshot.json');
  const receipt = run(['export', '--file', file]);
  assert.equal(receipt.file, file);
  assert.equal(receipt.issues, 1);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), run(['export']));
  const before = readFileSync(file);
  const refused = run(['export', '--file', file], { status: 1 });
  assert.equal(refused.error.code, 'internal_error');
  assert.deepEqual(readFileSync(file), before);
});

test('CLI reports retired stores for writes while reads and exports remain available', async t => {
  const { root, cwd, directory, run } = fixture(t);
  run(['init']);
  const issue = run(['create', '--tool', 'tool', '--project', 'project', '--body', 'Keep this issue']).issue;
  const memory = run(['memory', 'create', '--project', 'project', '--title', 'Keep this memory', '--body', 'Memory body']).memory;
  const snapshot = run(['export']);
  const alreadyOpenStore = openStore({ directory, cwd });
  const retirement = retire(directory);
  const message = 'This local database is retired. Use cloud connection archive.';
  const writes = [
    ['create', '--tool', 'tool', '--project', 'project', '--body', 'Blocked issue'],
    ['comment', issue.id, '--body', 'Blocked comment'],
    ['update', issue.id, '--body', 'Blocked update', '--expect', 'body=1'],
    ['close', issue.id, '--expected', '1'],
    ['reopen', issue.id, '--expected', '1'],
    ['memory', 'create', '--project', 'project', '--title', 'Blocked memory', '--body', 'Blocked body'],
    ['memory', 'update', memory.id, '--project', 'project', '--title', 'Blocked title', '--body', 'Blocked body', '--expected', '1'],
    ['memory', 'delete', memory.id, '--project', 'project', '--expected', '1'],
  ];
  try {
    for (const args of writes) assert.deepEqual(run(args, { status: 4 }).error, { code: 'store_retired', message });
    await assert.rejects(alreadyOpenStore.db.batch([{ sql: 'UPDATE issues SET body = body WHERE id = ?', params: [issue.id] }]),
      error => error instanceof Error && 'code' in error && error.code === 'store_retired' && error.message === message);
    assert.equal(run(['list']).issues.length, 1);
    assert.equal(run(['show', issue.id]).issue.body, 'Keep this issue');
    const shownMemory = run(['memory', 'show', memory.id, '--project', 'project']).memory;
    assert.equal(shownMemory.title, 'Keep this memory');
    assert.equal(shownMemory.body, 'Memory body');
    const context = run(['memory', 'context', '--project', 'project', '--with-revision']);
    assert.equal(context.memories[0]?.body, 'Memory body');
    assert.ok(context.memory_revision);
    assert.deepEqual(run(['export']), snapshot);

    const destination = join(root, 'empty-retired-store');
    const destinationCli = (args: string[], options: { status?: number; input?: string } = {}) => plainCli(cwd,
      ['--data-dir', destination, '--actor', 'local:restorer', ...args], options);
    destinationCli(['init']);
    const destinationRetirement = retire(destination);
    try {
      assert.deepEqual(destinationCli(['import', '--file', '-'], { input: JSON.stringify(snapshot), status: 4 }).error,
        { code: 'store_retired', message });
      assert.deepEqual(destinationCli(['export']), { format: 'polylinedb.snapshot', version: 5, issue_claims: [], claim_requests: [],
        issues: [], comments: [], counters: [], requests: [], memories: [], memory_counters: [], memory_requests: [], dependencies: [], dependency_revisions: [], dependency_requests: [] });
    } finally { destinationRetirement.close(); }
  } finally {
    retirement.close();
    alreadyOpenStore.close();
  }
});

test('CLI does not classify lookalike or partial retirement triggers as a retired store', t => {
  const { root, cwd, run } = fixture(t);
  const lookalikeDirectory = join(root, 'lookalike-store');
  const lookalike = (args: string[], options: { status?: number } = {}) => plainCli(cwd,
    ['--data-dir', lookalikeDirectory, '--actor', 'local:test', ...args], options);
  lookalike(['init']);
  const message = 'This local database is retired. Use cloud connection archive.';
  const lookalikeDatabase = new DatabaseSync(join(lookalikeDirectory, 'polylinedb.sqlite'));
  lookalikeDatabase.exec(`CREATE TRIGGER lookalike BEFORE INSERT ON counters BEGIN SELECT RAISE(ABORT, '${message}'); END`);
  lookalikeDatabase.close();
  assert.deepEqual(lookalike(['create', '--tool', 'tool', '--project', 'project', '--body', 'Blocked'], { status: 1 }).error,
    { code: 'internal_error', message });

  const partialDirectory = join(root, 'partial-retired-store');
  const partial = (args: string[], options: { status?: number } = {}) => plainCli(cwd,
    ['--data-dir', partialDirectory, '--actor', 'local:test', ...args], options);
  partial(['init']);
  const partialRetirement = retire(partialDirectory);
  try {
    partialRetirement.exec('DROP TRIGGER polylinedb_retired_issues_insert');
  } finally { partialRetirement.close(); }
  assert.deepEqual(partial(['create', '--tool', 'tool', '--project', 'project', '--body', 'Blocked'], { status: 1 }).error,
    { code: 'internal_error', message });

  const mixedDirectory = join(root, 'mixed-retired-store');
  const mixed = (args: string[], options: { status?: number } = {}) => plainCli(cwd,
    ['--data-dir', mixedDirectory, '--actor', 'local:test', ...args], options);
  mixed(['init']);
  const mixedRetirement = retire(mixedDirectory);
  const differentMessage = 'This local database is retired. Use cloud connection different.';
  try {
    mixedRetirement.exec(`DROP TRIGGER polylinedb_retired_counters_insert; CREATE TRIGGER "polylinedb_retired_counters_insert" BEFORE INSERT ON "counters" BEGIN SELECT RAISE(ABORT, '${differentMessage}'); END`);
  } finally { mixedRetirement.close(); }
  assert.deepEqual(mixed(['create', '--tool', 'tool', '--project', 'project', '--body', 'Blocked'], { status: 1 }).error,
    { code: 'internal_error', message: differentMessage });
});

test('CLI sequential IDs support natural pagination, child aliases and explicit prefix overrides', t => {
  const { run } = fixture(t);
  run(['init']);
  const epic = run(['create', '--tool', 'tool', '--project', 'project', '--type', 'epic', '--body', 'Parent']).issue;
  assert.equal(epic.id, 'pd-1');
  const child = run(['create', '--tool', 'tool', '--project', 'project', '--parent', '1', '--body', 'Child']).issue;
  assert.equal(child.id, 'pd-1.1');
  assert.equal(run(['show', '1.1']).issue.id, child.id);
  assert.equal(run(['comment', '1.1', '--body', 'Numeric child']).comment.issue_id, child.id);
  assert.equal(run(['update', '1.1', '--priority', '0', '--expect', 'priority=1']).issue.priority, 0);
  assert.equal(run(['close', '1.1', '--expected', '1']).issue.status, 'closed');
  assert.equal(run(['reopen', '1.1', '--expected', '2']).issue.status, 'open');
  for (let number = 2; number <= 12; number += 1) {
    assert.equal(run(['create', '--tool', 'tool', '--project', 'project', '--body', `Root ${number}`]).issue.id, `pd-${number}`);
  }
  const page = run(['list', '--after', '9', '--limit', '3']);
  assert.deepEqual(page.issues.map((issue: { id: string }) => issue.id), ['pd-10', 'pd-11', 'pd-12']);
  const other = run(['--prefix', 'other', 'create', '--tool', 'tool', '--project', 'project', '--body', 'Other prefix']).issue;
  assert.equal(other.id, 'other-1');
  assert.equal(run(['show', '1', '--prefix', 'other']).issue.id, other.id);
  assert.equal(run(['show', 'pd-1', '--prefix', 'other']).issue.id, epic.id);
});

test('CLI create retries reuse a supplied request ID and automatic IDs create separate issues', t => {
  const { run } = fixture(t);
  run(['init']);
  const requestId = '93373171-1d3b-466c-a10f-bf4cc556d9d5';
  const command = ['create', '--tool', 'tool', '--project', 'project', '--body', 'Retry intent', '--request-id', requestId];
  const initial = run(command).issue;
  assert.equal(initial.id, 'pd-1');
  assert.equal(run(command).issue.id, initial.id);
  assert.equal(run(['list']).issues.length, 1);
  run([...command.slice(0, -4), '--body', 'Different intent', '--request-id', requestId], { status: 4 });
  assert.equal(run(['show', '1']).issue.body, 'Retry intent');
  const next = run(command.slice(0, -2)).issue;
  assert.equal(next.id, 'pd-2');
  assert.equal(run(command.slice(0, -2)).issue.id, 'pd-3');
  assert.equal(run(['create', '--tool', 'tool', '--project', 'project', '--body', 'Bad request', '--request-id', 'not-uuid'], { status: 2 }).error.code, 'invalid_input');
});

test('stealth prefix is persisted, shown by context and checked before storage creation', t => {
  const { root, cwd, directory } = fixture(t);
  git(cwd, ['init', '--quiet']);
  plainCli(cwd, ['init', '--stealth', '--data-dir', directory, '--prefix', 'mut', '--tool', 'tool', '--project', 'project', '--actor', 'local:owner']);
  assert.equal(plainCli(cwd, ['context']).prefix, 'mut');
  assert.equal(plainCli(cwd, ['create', '--body', 'Repository prefix']).issue.id, 'mut-1');
  assert.equal(plainCli(cwd, ['show', '1']).issue.id, 'mut-1');
  assert.equal(plainCli(cwd, ['create', '--prefix', 'pd', '--body', 'Override prefix']).issue.id, 'pd-1');
  const config = JSON.parse(readFileSync(join(cwd, '.git', 'polylinedb.json'), 'utf8'));
  assert.equal(config.version, 2);
  assert.equal(config.prefix, 'mut');
  for (const prefix of ['UPPER', 'with-dash', 'a'.repeat(17), '']) {
    const store = join(root, `invalid-${prefix || 'empty'}`);
    plainCli(cwd, ['init', '--data-dir', store, '--prefix', prefix], { status: 2 });
    assert.equal(existsSync(store), false);
  }
});

test('CLI exposes named prerequisite endpoints, natural shorthand, worklists, and force reasons', t => {
  const { run } = fixture(t); run(['--prefix', 'demo', 'init']);
  for (let i = 0; i < 2; i++) run(['--prefix', 'demo', 'create', '--tool', 'compiler', '--project', 'test', '--body', `Issue ${i}`]);
  const input = ['--prefix', 'demo', 'dependency', 'add', '--dependent', '1', '--blocker', '2', '--expected-revision', '1', '--request-id', crypto.randomUUID()];
  const result = run(input); assert.equal(result.dependency.outcome, 'added'); assert.deepEqual(run(input), result);
  assert.deepEqual(run(['--prefix', 'demo', 'dependency', 'list', '1']).blockers.map((row: { id: string }) => row.id), ['demo-2']);
  assert.deepEqual(run(['blocked', '--project', 'test']).issues.map((row: { id: string }) => row.id), ['demo-1']);
  assert.deepEqual(run(['ready', '--project', 'test']).issues.map((row: { id: string }) => row.id), ['demo-2']);
  assert.equal(run(['--prefix', 'demo', 'close', '1', '--expected', '1'], { status: 4 }).error.code, 'dependency_blocked');
  run(['--prefix', 'demo', 'close', '1', '--expected', '1', '--force', '--reason', 'Accepted exception']);
  assert.equal(run(['--prefix', 'demo', 'show', '1']).comments[0].body, 'Accepted exception');
  assert.equal(run(['--prefix', 'demo', 'dependency', 'remove', '--dependent', '1', '--blocker', '2', '--expected-revision', '2']).dependency.outcome, 'removed');
});
