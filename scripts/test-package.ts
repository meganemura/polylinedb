// Verifies the distributable through npm installation; source-tree imports cannot satisfy this check.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'polylinedb-package-'));
const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
  HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config-home'), npm_config_cache: join(root, 'cache'), npm_config_audit: 'false', npm_config_fund: 'false' };
delete env.POLYLINEDB_ACTOR;
delete env.POLYLINEDB_DATA_DIR;
delete env.POLYLINEDB_CONNECTION;

function run(command: string, args: string[], cwd: string, expected = 0): string {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, expected, `${command}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

try {
  mkdirSync(env.HOME!);
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts=false', '--foreground-scripts=false', '--pack-destination', root], project));
  assert.equal(packed.length, 1);
  const pack = packed[0];
  assert.equal(pack.name, 'polylinedb');
  const expectedFiles = ['LICENSE', 'CHANGELOG.md', 'README.md', 'package.json', 'dist/cli.js', "dist/records/issues.js",
    "dist/records/schema.js", 'dist/sqlite.js', "dist/records/snapshot.js", 'dist/local-config.js', 'dist/connections.js', "dist/records/issue-id.js",
    'dist/cloud-client/index.js', 'dist/cloud-client/cloud-operations.js', 'dist/cloud-client/oauth.js', 'dist/cloud-client/credential-session.js', 'dist/cloud-client/credential-store.js',
    "dist/records/issue-queries.js", "dist/records/solarsql.generated.js", "dist/records/memories.js", "dist/records/operations.js", 'dist/records/index.js', 'dist/records/persistence.js', 'docs/memory.md', 'docs/adr/0003-project-memory.md', 'docs/operations.md', 'skills/polylinedb/SKILL.md', 'docs/architecture.md',
    'docs/cloud.md', 'docs/cli-authentication.md', 'docs/connections.md', 'docs/d1-migration.md', 'docs/dependencies.md', 'docs/releasing.md', 'docs/secure-mcp-tunnel.md', 'docs/adr/0001-field-versions.md', 'docs/adr/0002-solarsql-reads.md',
    'docs/local-cloud-cutover.md', 'docs/adr/0004-shared-cloud-cutover.md', 'docs/migration.md',
    'dist/agent-hooks.js', 'docs/host-hooks.md', 'docs/adr/0005-memory-freshness.md', 'docs/adr/0006-capability-boundaries.md', 'docs/verification.md'].sort();
  assert.deepEqual(pack.files.map((file: { path: string }) => file.path).sort(), expectedFiles);
  const tarball = join(root, pack.filename);
  const prefix = join(root, 'install');
  run('npm', ['install', '--prefix', join(root, 'dependency-cache'), '--ignore-scripts', '--omit=dev', '--package-lock=false', 'solarsql@0.7.1'], root);
  run('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--omit=dev', '--offline', tarball], root);
  const installed = join(prefix, 'lib', 'node_modules', 'polylinedb');
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.private, undefined);
  assert.deepEqual(manifest.dependencies, { solarsql: '0.7.1' });
  assert.equal(manifest.engines.node, '^24.20.0 || >=26.7.0');
  assert.equal(manifest.bin.pd, 'dist/cli.js');
  const command = join(prefix, 'bin', 'pd');
  assert.equal(realpathSync(command), realpathSync(join(installed, 'dist', 'cli.js')));
  const workspace = join(root, 'work');
  mkdirSync(workspace);
  const directory = join(root, 'store');
  const pd = (args: string[], expected = 0) => run(command, ['--data-dir', directory, '--actor', 'test:package', ...args], workspace, expected);
  assert.match(pd(['--help']), /Usage: pd /);
  assert.match(pd(['--help']), /polyline database/);
  assert.equal(JSON.parse(pd(['init'])).database_path, join(realpathSync(directory), 'polylinedb.sqlite'));
  const requestId = '5a64d5b0-b93a-4d9b-8b55-287edaf68390';
  const creation = ['create', '--tool', 'package-test', '--project', 'release', '--body', 'Installed CLI', '--request-id', requestId];
  const { issue } = JSON.parse(pd(creation));
  assert.equal(issue.body, 'Installed CLI');
  assert.equal(issue.id, 'pd-1');
  assert.equal(JSON.parse(pd(creation)).issue.id, issue.id);
  assert.equal(JSON.parse(pd(['show', '1'])).issue.id, issue.id);
  assert.equal(JSON.parse(pd(['show', issue.id])).issue.created_by, 'test:package');
  assert.equal(JSON.parse(pd(['update', issue.id, '--status', 'in_progress', '--expect', 'status=1'])).issue.versions.status, 2);
  pd(['close', issue.id, '--expected', '1'], 4);
  assert.equal(JSON.parse(pd(['comment', issue.id, '--body', 'Works from npm'])).comment.body, 'Works from npm');
  assert.equal(JSON.parse(pd(['search', 'Works from npm'])).issues[0].id, issue.id);
  assert.equal(JSON.parse(pd(['close', issue.id, '--expected', '2'])).issue.status, 'closed');
  assert.equal(JSON.parse(pd(['reopen', issue.id, '--expected', '3'])).issue.status, 'open');
  const memoryCreation = ['memory', 'create', '--project', 'release', '--title', 'Package fact', '--body', 'Installed sessions share this memory.', '--request-id', '56361bb3-2f79-4e47-bd3a-4d0b52d9b7cc'];
  assert.equal(JSON.parse(pd(memoryCreation)).memory.id, 'pd-m1');
  assert.equal(JSON.parse(pd(['memory', 'context', '--project', 'release'])).memories[0].body, 'Installed sessions share this memory.');
  const observation = JSON.parse(pd(['memory', 'context', '--project', 'release', '--with-revision'])).memory_revision;
  assert.equal(JSON.parse(pd(['list', '--project', 'release', '--observed-memory-revision', observation])).memory_freshness.status, 'current');
  assert.equal(JSON.parse(pd(['memory', 'update', '1', '--project', 'release', '--title', 'Package fact', '--body', 'Verified through the installed CLI.', '--expected', '1'])).memory.version, 2);
  assert.equal(JSON.parse(pd(['list', '--project', 'release', '--observed-memory-revision', observation])).memory_freshness.reason, 'memory_changed');
  pd(['memory', 'delete', '1', '--project', 'release', '--expected', '1'], 4);
  const skill = readFileSync(join(installed, 'skills', 'polylinedb', 'SKILL.md'), 'utf8');
  assert.match(skill, /pd memory context/);
  assert.match(skill, /context compaction/);
  const snapshotPath = join(root, 'snapshot.json');
  const exported = JSON.parse(pd(['export', '--file', snapshotPath]));
  const restoredDirectory = join(root, 'restored');
  const restored = (args: string[], expected = 0) => run(command, ['--data-dir', restoredDirectory, '--actor', 'test:package', ...args], workspace, expected);
  restored(['init']);
  const imported = JSON.parse(restored(['import', '--file', snapshotPath]));
  assert.equal(imported.result, 'imported');
  assert.equal(imported.sha256, exported.sha256);
  assert.deepEqual(JSON.parse(restored(['export'])), JSON.parse(pd(['export'])));
  assert.equal(JSON.parse(restored(['import', '--file', snapshotPath])).result, 'already_present');
  assert.equal(JSON.parse(restored(creation)).issue.id, issue.id);
  assert.equal(JSON.parse(restored(['show', issue.id])).issue.versions.status, 4);
  assert.equal(JSON.parse(restored(['show', issue.id])).comments[0].body, 'Works from npm');
  assert.equal(JSON.parse(restored(['memory', 'show', '1', '--project', 'release'])).memory.version, 2);
  assert.equal(JSON.parse(restored(memoryCreation)).memory.body, 'Verified through the installed CLI.');
  assert.equal(JSON.parse(restored(['create', '--tool', 'package-test', '--project', 'release', '--body', 'After restoration'])).issue.id, 'pd-2');
  restored(['import', '--file', snapshotPath], 4);
  assert.deepEqual(readdirSync(workspace), []);
  assert.deepEqual(readdirSync(directory), ['polylinedb.sqlite']);
  const connected = (args: string[], expected = 0) => JSON.parse(run(command, args, workspace, expected));
  connected(['connection', 'add', 'home', '--data-dir', directory]);
  connected(['connection', 'add', 'cloud', '--url', 'https://issues.example.invalid']);
  run('git', ['init', '--quiet', workspace], root);
  const named = connected(['init', '--connection', 'home', '--actor', 'test:package', '--tool', 'package-test', '--project', 'release']);
  assert.equal(named.database_path, join(realpathSync(directory), 'polylinedb.sqlite'));
  assert.equal(connected(['context']).connection, 'home');
  assert.equal(connected(['agent', 'install', 'claude']).installed, true);
  const hook = spawnSync(command, ['agent', 'context', 'claude'], { cwd: workspace, env, encoding: 'utf8', input: JSON.stringify({ cwd: workspace }) });
  assert.equal(hook.status, 0, hook.stderr);
  const injected = JSON.parse(hook.stdout).hookSpecificOutput.additionalContext;
  assert.match(injected, /Verified through the installed CLI/);
  assert.match(injected, /memory_revision/);
  assert.equal(connected(['agent', 'remove', 'claude']).removed, true);
  connected(['connection', 'use', 'cloud']);
  assert.equal(connected(['context']).mode, 'cloud');
  for (const arguments_ of [['auth', 'status', 'extra'], ['auth', 'unknown'], ['auth', 'login', '--actor', 'local:spoof']]) {
    const rejected = spawnSync(command, arguments_, { cwd: workspace, env, encoding: 'utf8' });
    assert.equal(rejected.status, 2);
    assert.equal(JSON.parse(rejected.stderr).error.code, 'invalid_input');
    assert.equal(rejected.stdout, '');
  }
  const unavailable = spawnSync(command, ['export', '--file', join(root, 'cloud-export.json')], { cwd: workspace, env, encoding: 'utf8' });
  assert.equal(unavailable.status, 2);
  assert.equal(JSON.parse(unavailable.stderr).error.code, 'cloud_snapshot_not_supported');
  connected(['connection', 'use', 'home']);
  assert.equal(connected(['show', '1']).issue.id, issue.id);
  const cloudTests = spawnSync(process.execPath, ['--test', 'test/cli-cloud.test.ts'], {
    cwd: project, env: { ...env, PD_CLI_EXECUTABLE: join(installed, 'dist', 'cli.js') }, encoding: 'utf8',
  });
  assert.equal(cloudTests.status, 0, cloudTests.stdout + cloudTests.stderr);
  const destination = process.argv[2];
  if (destination) {
    const { copyFileSync } = await import('node:fs');
    copyFileSync(tarball, resolve(destination));
  }
  process.stdout.write(JSON.stringify({ name: pack.name, version: pack.version, integrity: pack.integrity,
    files: pack.files.length, packedBytes: pack.size, node: process.version, result: 'pass' }) + '\n');
} finally { rmSync(root, { recursive: true, force: true }); }
