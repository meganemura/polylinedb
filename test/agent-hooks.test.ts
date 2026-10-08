import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { contextChildLimitMs, hookTimeoutSeconds } from '../src/host-hooks/index.ts';
import { childLimits } from './fixtures/child-run.ts';

const executable = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
// The hook's own CLI child pays the same node start wait on a loaded host as the children that child-run.ts limits.
const hookCliLimitMs = String(childLimits.startMs + childLimits.runMs);
type Host = 'claude' | 'codex' | 'cursor';
type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function settingsPath(home: string, host: Host): string {
  if (host === 'claude') return join(home, '.claude', 'settings.json');
  return join(home, host === 'codex' ? '.codex' : '.cursor', 'hooks.json');
}

function environment(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), PD_TEST_HOOK_CLI_LIMIT_MS: hookCliLimitMs };
  delete env.POLYLINEDB_ACTOR;
  delete env.POLYLINEDB_ACTOR_KIND;
  delete env.POLYLINEDB_DATA_DIR;
  delete env.POLYLINEDB_CONNECTION;
  delete env.CURSOR_PROJECT_DIR;
  delete env.CLAUDE_PROJECT_DIR;
  Object.assign(env, extra);
  return env;
}

function run(home: string, cwd: string, args: string[], options: { input?: string; status?: number; env?: Record<string, string> } = {}): unknown {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd, env: environment(home, options.env), encoding: 'utf8', input: options.input,
  });
  assert.equal(result.status, options.status ?? 0, result.stderr);
  if (result.status === 0) assert.equal(result.stderr, '');
  else assert.equal(result.stdout, '');
  return JSON.parse(result.status === 0 ? result.stdout : result.stderr);
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function fixture(t: { after(callback: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'pd-agent-hooks-'));
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  const store = join(root, 'store');
  mkdirSync(home);
  mkdirSync(cwd);
  git(cwd, ['init', '--quiet']);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const initialized = run(home, cwd, ['init', '--stealth', '--data-dir', store, '--tool', 'test', '--project', 'demo', '--actor', 'local:test']);
  assert.ok(isRecord(initialized));
  run(home, cwd, ['memory', 'create', '--title', 'Session preference', '--body', 'Use the test command before changing the parser.', '--request-id', '123e4567-e89b-12d3-a456-426614174000']);
  return { home, cwd };
}

function contextText(host: Host, value: unknown): string {
  assert.ok(isRecord(value));
  if (host === 'cursor') {
    const context = value.additional_context;
    if (typeof context !== 'string') throw new Error('Cursor hook output lacks additional_context');
    return context;
  }
  assert.ok(isRecord(value.hookSpecificOutput));
  assert.equal(value.hookSpecificOutput.hookEventName, 'SessionStart');
  const context = value.hookSpecificOutput.additionalContext;
  if (typeof context !== 'string') throw new Error('SessionStart hook output lacks additionalContext');
  return context;
}

function installedHook(host: Host, settings: unknown): JsonObject {
  assert.ok(isRecord(settings) && isRecord(settings.hooks));
  const entries = settings.hooks[host === 'cursor' ? 'sessionStart' : 'SessionStart'];
  assert.ok(Array.isArray(entries));
  const handlers = host === 'cursor' ? entries : entries.flatMap(entry => isRecord(entry) && Array.isArray(entry.hooks) ? entry.hooks : []);
  const owned = handlers.filter(handler => isRecord(handler) && handler.command === `pd agent context ${host}`);
  assert.equal(owned.length, 1);
  assert.ok(isRecord(owned[0]));
  return owned[0];
}

test('host hooks install, retrieve CLI memory, and remove only their own settings', t => {
  const { home, cwd } = fixture(t);
  const trackedState = git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  const originals: Record<Host, JsonObject> = {
    claude: { permissions: { allow: ['Read'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] } },
    codex: { model: 'test-model', hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo keep' }] }] } },
    cursor: { version: 1, hooks: { preToolUse: [{ command: 'echo keep' }] } },
  };
  for (const host of ['claude', 'codex', 'cursor'] as const) {
    const path = settingsPath(home, host);
    mkdirSync(join(home, host === 'claude' ? '.claude' : host === 'codex' ? '.codex' : '.cursor'));
    const original = originals[host];
    writeFileSync(path, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o640 });
    chmodSync(path, 0o640);
    const installed = run(home, cwd, ['agent', 'install', host]);
    assert.ok(isRecord(installed));
    assert.equal(installed.changed, true);
    assert.equal(installed.installed, true);
    assert.equal(statSync(path).mode & 0o777, 0o640);
    const afterInstall = readFileSync(path, 'utf8');
    assert.equal(installedHook(host, JSON.parse(afterInstall)).timeout, 15);
    const repeated = run(home, cwd, ['agent', 'install', host]);
    assert.ok(isRecord(repeated));
    assert.equal(repeated.changed, false);
    assert.equal(readFileSync(path, 'utf8'), afterInstall);

    const input = host === 'cursor'
      ? JSON.stringify({ workspace_roots: [cwd], hook_event_name: 'sessionStart' })
      : JSON.stringify({ cwd, hook_event_name: 'SessionStart', source: 'startup' });
    const context = run(home, host === 'cursor' ? home : cwd, ['agent', 'context', host], {
      input,
      env: host === 'cursor' ? { CURSOR_PROJECT_DIR: cwd } : {},
    });
    const injected = contextText(host, context);
    assert.match(injected, /untrusted project data/);
    assert.match(injected, /"project":"demo"/);
    assert.match(injected, /Use the test command before changing the parser/);
    assert.match(injected, /"omitted":false/);
    assert.doesNotMatch(injected, /database_path|store\.database_path/);

    const removed = run(home, cwd, ['agent', 'remove', host]);
    assert.ok(isRecord(removed));
    assert.equal(removed.changed, true);
    assert.equal(removed.removed, true);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), original);
    const afterRemove = readFileSync(path, 'utf8');
    const repeatedRemove = run(home, cwd, ['agent', 'remove', host]);
    assert.ok(isRecord(repeatedRemove));
    assert.equal(repeatedRemove.changed, false);
    assert.equal(readFileSync(path, 'utf8'), afterRemove);
    assert.equal(readFileSync(path).length > 0, true);
  }
  assert.equal(git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']), trackedState);
  assert.deepEqual(readdirSync(cwd), ['.git']);
});

test('Codex keeps the full bounded context and its omission metadata', t => {
  const { home, cwd } = fixture(t);
  run(home, cwd, ['memory', 'create', '--title', 'Large entry', '--body', 'x'.repeat(6000), '--request-id', '123e4567-e89b-12d3-a456-426614174001']);
  run(home, cwd, ['memory', 'create', '--title', 'Next entry', '--body', 'y'.repeat(5000), '--request-id', '123e4567-e89b-12d3-a456-426614174002']);
  run(home, cwd, ['agent', 'install', 'codex']);
  const settings = JSON.parse(readFileSync(settingsPath(home, 'codex'), 'utf8'));
  const limit = settings.hooks.SessionStart[0].hooks[0].additionalContextLimit;
  const injected = contextText('codex', run(home, cwd, ['agent', 'context', 'codex'], { input: JSON.stringify({ cwd }) }));
  assert.ok(injected.length > 5000);
  assert.ok(injected.length <= limit);
  const data = JSON.parse(injected.slice(injected.indexOf('\n') + 1));
  assert.match(data.memory_revision, /^pm1\./);
  assert.equal(data.omitted, true);
  assert.ok(data.notices.length > 0);
  assert.ok(data.memories.some((memory: { body: string }) => memory.body === 'x'.repeat(6000)));
});

test('the context child limit leaves the hook time to answer before the host cap', () => {
  assert.equal(hookTimeoutSeconds, 15);
  assert.equal(contextChildLimitMs, 10_000);
  assert.ok(contextChildLimitMs < hookTimeoutSeconds * 1000);
});

test('a CLI child that outlives the hook limit returns the unavailable status', t => {
  const { home, cwd } = fixture(t);
  const result = run(home, cwd, ['agent', 'context', 'claude'], {
    input: JSON.stringify({ cwd }),
    env: { PD_TEST_HOOK_CLI_LIMIT_MS: '1' },
  });
  const message = contextText('claude', result);
  assert.equal(message, 'Polylinedb memory retrieval failed (unavailable). No memory was added. Continue without it; do not infer that the selected project has no memory.');
  assert.doesNotMatch(message, /untrusted project data/);
});

test('installation refuses symlinked settings and ambiguous owned commands', t => {
  const { home, cwd } = fixture(t);
  const directory = join(home, '.claude');
  mkdirSync(directory);
  const target = join(home, 'elsewhere.json');
  const targetContent = '{"keep":true}\n';
  writeFileSync(target, targetContent);
  symlinkSync(target, join(directory, 'settings.json'));
  const linked = run(home, cwd, ['agent', 'install', 'claude'], { status: 4 });
  assert.ok(isRecord(linked));
  assert.equal(recordErrorCode(linked), 'agent_settings_unsafe_path');
  assert.equal(readFileSync(target, 'utf8'), targetContent);

  rmSync(join(directory, 'settings.json'));
  const path = join(directory, 'settings.json');
  writeFileSync(path, '{invalid json');
  const malformed = run(home, cwd, ['agent', 'install', 'claude'], { status: 2 });
  assert.ok(isRecord(malformed));
  assert.equal(recordErrorCode(malformed), 'agent_settings_invalid_json');
  assert.equal(readFileSync(path, 'utf8'), '{invalid json');

  const ambiguous = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'pd agent context claude', matcher: 'startup' }] }] } };
  const before = `${JSON.stringify(ambiguous, null, 2)}\n`;
  writeFileSync(path, before);
  const refused = run(home, cwd, ['agent', 'install', 'claude'], { status: 4 });
  assert.ok(isRecord(refused));
  assert.equal(recordErrorCode(refused), 'agent_hook_ownership_ambiguous');
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('install creates a private user settings file and removal leaves no hook entry', t => {
  const { home, cwd } = fixture(t);
  const installed = run(home, cwd, ['agent', 'install', 'claude']);
  assert.ok(isRecord(installed));
  assert.equal(installed.changed, true);
  const path = settingsPath(home, 'claude');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const content = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(isRecord(content));
  assert.ok(isRecord(content.hooks));
  assert.ok(Array.isArray(content.hooks.SessionStart));
  const removed = run(home, cwd, ['agent', 'remove', 'claude']);
  assert.ok(isRecord(removed));
  assert.equal(removed.changed, true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {});
});

test('an active settings lock prevents a concurrent update without rewriting the file', t => {
  const { home, cwd } = fixture(t);
  const directory = join(home, '.codex');
  mkdirSync(directory);
  const path = join(directory, 'hooks.json');
  const original = '{"model":"keep"}\n';
  writeFileSync(path, original);
  writeFileSync(`${path}.polylinedb.lock`, JSON.stringify({ pid: process.pid, token: 'held' }));
  const refused = run(home, cwd, ['agent', 'install', 'codex'], { status: 4 });
  assert.ok(isRecord(refused));
  assert.equal(recordErrorCode(refused), 'agent_settings_locked');
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('a Cursor workspace ambiguity returns a non-blocking status without raw stderr', t => {
  const { home, cwd } = fixture(t);
  const other = join(cwd, 'other');
  mkdirSync(other);
  const result = run(home, cwd, ['agent', 'context', 'cursor'], {
    input: JSON.stringify({ workspace_roots: [cwd, other] }),
  });
  const message = contextText('cursor', result);
  assert.match(message, /ambiguous_workspace/);
  assert.match(message, /Continue without it/);
});

function recordErrorCode(value: JsonObject): unknown {
  if (!isRecord(value.error)) return undefined;
  return value.error.code;
}
