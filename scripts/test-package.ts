// Verifies the distributable through npm installation; source-tree imports cannot satisfy this check.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('..', import.meta.url));
const runtimePreload = fileURLToPath(new URL('../test/fixtures/cli-runtime-preload.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'polylinedb-package-'));
const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
  HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config-home'), npm_config_cache: join(root, 'cache'), npm_config_audit: 'false', npm_config_fund: 'false' };
delete env.POLYLINEDB_ACTOR;
delete env.POLYLINEDB_ACTOR_KIND;
delete env.POLYLINEDB_DATA_DIR;
delete env.POLYLINEDB_CONNECTION;
delete env.POLYLINEDB_SESSION_ID;

function run(command: string, args: string[], cwd: string, expected = 0): string {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, expected, `${command}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

function invokeAtNodeVersion(nodeVersion: string, command: string, args: string[], cwd: string, commandEnv: NodeJS.ProcessEnv = env) {
  const result = spawnSync(process.execPath, ['--import', runtimePreload, command, ...args], {
    cwd, env: { ...commandEnv, PD_TEST_NODE_VERSION: nodeVersion }, encoding: 'utf8',
  });
  assert.ifError(result.error);
  return result;
}

try {
  mkdirSync(env.HOME!);
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts=false', '--foreground-scripts=false', '--pack-destination', root], project));
  assert.equal(packed.length, 1);
  const pack = packed[0];
  assert.equal(pack.name, 'polylinedb');
  const expectedFiles = ['LICENSE', 'CHANGELOG.md', 'README.md', 'package.json', 'dist/cli.js', 'dist/cli-help.js', 'dist/cli-commands.js', 'dist/cli-human.js', 'dist/cli-diagnostics.js', "dist/records/issues.js",
    "dist/records/schema.js", "dist/local-store/index.js", "dist/records/snapshot.js", "dist/workspace/local-config.js", "dist/workspace/connections.js", 'dist/workspace/index.js', "dist/records/issue-id.js",
    'dist/cloud-client/index.js', 'dist/cloud-client/cloud-operations.js', 'dist/cloud-client/oauth.js', 'dist/cloud-client/credential-session.js', 'dist/cloud-client/credential-store.js',
    "dist/records/issue-queries.js", "dist/records/solarsql.generated.js", "dist/records/memories.js", "dist/records/operations.js", 'dist/records/index.js', 'dist/records/persistence.js', 'docs/memory.md', 'docs/adr/0003-project-memory.md', 'docs/operations.md', 'skills/polylinedb/SKILL.md', 'skills/polylinedb-queue/SKILL.md', 'docs/agent-workflow.md', 'docs/architecture.md',
    'docs/cloud.md', 'docs/cli-authentication.md', 'docs/connections.md', 'docs/d1-migration.md', 'docs/dependencies.md', 'docs/releasing.md', 'docs/secure-mcp-tunnel.md', 'docs/adr/0001-field-versions.md', 'docs/adr/0002-solarsql-reads.md',
    'docs/local-cloud-cutover.md', 'docs/adr/0004-shared-cloud-cutover.md', 'docs/migration.md', 'docs/adr/0007-cli-runtime-admission.md',
    "dist/host-hooks/index.js", 'docs/host-hooks.md', 'docs/adr/0005-memory-freshness.md', 'docs/adr/0006-capability-boundaries.md', 'docs/verification.md', 'dist/records/dependencies.js', 'docs/prerequisites.md', 'docs/adr/0008-issue-prerequisites.md',
    'dist/records/errors.js', 'dist/records/claims.js', 'dist/records/claims-sql.js', 'dist/records/schema-v5.js', 'dist/records/schema-v6.js', 'docs/claims.md', 'docs/adr/0009-issue-ownership.md',
    'docs/adr/0010-human-output.md', 'dist/records/operation-policy.js', 'dist/records/agent-gate.js', 'dist/transition/index.js', 'dist/transition/claims.js', 'dist/transition/cross-issue.js', 'dist/transition/issue-update.js', 'dist/transition/receipts.js', 'dist/transition/vocabulary.js', 'dist/transition/agent-gate.js', 'docs/agent-actors.md', 'docs/issue-authority.md', 'docs/adr/0011-issue-authority-layers.md', "docs/adr/0012-restored-d1-addition.md", "docs/adr/0013-cloud-actor-roles.md", "docs/adr/0014-mcp-operation-hints.md", "docs/adr/0015-deferred-cloud-client.md", "docs/adr/0016-change-feed.md", "docs/bun-runtime.md", "docs/depug-debugging.md"].sort();
  assert.deepEqual(pack.files.map((file: { path: string }) => file.path).sort(), expectedFiles);
  const tarball = join(root, pack.filename);
  const prefix = join(root, 'install');
  const dependencyPack = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root, join(project, 'node_modules', 'solarsql')], root));
  assert.equal(dependencyPack[0].name, 'solarsql'); assert.equal(dependencyPack[0].version, '0.7.1');
  const dependencyTarball = join(root, dependencyPack[0].filename);
  run('npm', ['install', '--global', '--prefix', prefix, '--ignore-scripts', '--omit=dev', '--offline', tarball, dependencyTarball], root);
  const installed = join(prefix, 'lib', 'node_modules', 'polylinedb');
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.private, undefined);
  assert.deepEqual(manifest.dependencies, { solarsql: '0.7.1' });
  assert.equal(manifest.engines.node, '^24.20.0 || >=26.7.0');
  assert.equal(manifest.bin.pd, 'dist/cli.js');
  const malformedRoot = join(root, 'malformed-package');
  const malformedDist = join(malformedRoot, 'dist');
  mkdirSync(malformedDist, { recursive: true });
  copyFileSync(join(installed, 'dist/cli.js'), join(malformedDist, 'cli.js'));
  writeFileSync(join(malformedRoot, 'package.json'), JSON.stringify({
    ...manifest,
    engines: { node: '^24.20.0 || >=26.7.0 <27' },
  }));
  const malformedManifest = invokeAtNodeVersion(process.versions.node, join(malformedDist, 'cli.js'), ['--version'], root);
  assert.equal(malformedManifest.status, 1, malformedManifest.stderr);
  assert.equal(malformedManifest.stdout, '');
  assert.equal(JSON.parse(malformedManifest.stderr).error.code, 'internal_error');
  writeFileSync(join(malformedRoot, 'package.json'), JSON.stringify(manifest));
  const missingCommands = invokeAtNodeVersion(process.versions.node, join(malformedDist, 'cli.js'), ['list'], root);
  assert.equal(missingCommands.status, 1, missingCommands.stderr);
  assert.equal(missingCommands.stdout, '');
  assert.equal(missingCommands.stderr.includes(malformedRoot), false, missingCommands.stderr);
  assert.deepEqual(JSON.parse(missingCommands.stderr).error, { code: 'internal_error', message: 'The command failed on an unexpected error.' });
  copyFileSync(join(installed, 'dist/cli-help.js'), join(malformedDist, 'cli-help.js'));
  const isolatedHelp = invokeAtNodeVersion('25.0.0', join(malformedDist, 'cli.js'), ['--help'], root);
  assert.equal(isolatedHelp.status, 0, isolatedHelp.stderr);
  assert.equal(isolatedHelp.stderr, '');
  assert.match(isolatedHelp.stdout, /^polylinedb \(polyline database\) stores personal issues/);
  assert.match(isolatedHelp.stdout, /\nUsage: pd /);
  const isolatedVersion = invokeAtNodeVersion('25.0.0', join(malformedDist, 'cli.js'), ['--version'], root);
  assert.equal(isolatedVersion.status, 0, isolatedVersion.stderr);
  assert.deepEqual(JSON.parse(isolatedVersion.stdout), { version: manifest.version, node: '25.0.0' });
  const command = join(prefix, 'bin', 'pd');
  assert.equal(realpathSync(command), realpathSync(join(installed, 'dist', 'cli.js')));
  const workspace = join(root, 'work');
  mkdirSync(workspace);
  const directory = join(root, 'store');
  for (const args of [['--version'], ['--version', '--json'], ['--json', '--version']]) {
    const version = invokeAtNodeVersion(process.versions.node, command, args, workspace);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stderr, '');
    assert.deepEqual(JSON.parse(version.stdout), { version: manifest.version, node: process.versions.node });
  }
  for (const nodeVersion of ['24.20.0', '24.99.99', '26.7.0', '27.0.0']) {
    const version = invokeAtNodeVersion(nodeVersion, command, ['--version'], workspace);
    assert.equal(version.status, 0, version.stderr);
    assert.deepEqual(JSON.parse(version.stdout), { version: manifest.version, node: nodeVersion });
  }
  const bodyVersion = invokeAtNodeVersion(process.versions.node, command,
    ['create', '--tool', 'package-test', '--project', 'release', '--body', '--version'], workspace);
  assert.equal(bodyVersion.status, 2, bodyVersion.stderr);
  assert.equal(JSON.parse(bodyVersion.stderr).error.code, 'invalid_input');
  assert.equal(bodyVersion.stdout, '');

  const sideEffectRoot = join(root, 'unsupported-runtime-effects');
  const unsupportedEnv: NodeJS.ProcessEnv = {
    ...env,
    HOME: join(sideEffectRoot, 'home'),
    XDG_CONFIG_HOME: join(sideEffectRoot, 'config'),
    XDG_DATA_HOME: join(sideEffectRoot, 'data'),
  };
  const helpText = run(command, ['--data-dir', join(sideEffectRoot, 'help-store'), '--help'], workspace);
  const helpCommands = [[], ['--help'], ['-h'], ['search', '--help'], ['claim', 'acquire', '--help'], ['--help', '--unknown']];
  const unsupportedCommands = [
    ['--unknown'], ['--unknown', '--help'], ['--version', '--help'], ['--actor', 'local:agent', '--help'],
    ['search', '--', '--help'], ['--data-dir', '--help', 'list'],
    ['create', '--tool', 'package-test', '--project', 'release', '--body', '--help'],
    ['--data-dir', join(sideEffectRoot, 'selected-store'), 'init'],
    ['list'], ['context'], ['connection', 'list'],
    ['connection', 'add', 'home', '--data-dir', join(sideEffectRoot, 'connection-store')], ['auth', 'status'],
  ];
  for (const nodeVersion of ['20.20.2', '24.18.0', '24.19.0', '25.0.0', '26.6.9', '24.20.0-rc.1']) {
    for (const args of helpCommands) {
      const result = invokeAtNodeVersion(nodeVersion, command, args, workspace, unsupportedEnv);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, helpText);
    }
    for (const args of [['--version'], ['--json', '--version']]) {
      const result = invokeAtNodeVersion(nodeVersion, command, args, workspace, unsupportedEnv);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { version: manifest.version, node: nodeVersion });
    }
    for (const args of unsupportedCommands) {
      const result = invokeAtNodeVersion(nodeVersion, command, args, workspace, unsupportedEnv);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.equal(result.stdout, '');
      const report = JSON.parse(result.stderr);
      assert.equal(report.error.code, 'unsupported_runtime');
      assert.deepEqual(report.error.details, {
        actual_node: nodeVersion,
        required_node: manifest.engines.node,
        package_version: manifest.version,
      });
      assert.match(report.error.message, new RegExp(nodeVersion.replaceAll('.', '\\.')));
      assert.ok(report.error.message.includes(manifest.engines.node));
    }
  }
  assert.equal(existsSync(sideEffectRoot), false);
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
  assert.equal(JSON.parse(pd(['comment', issue.id, '--body', '日本語の確認です。\n次の行です'])).comment.body, '日本語の確認です。\n次の行です');
  const controlBody = 'Package ESC:\u001b[31m C1:\u0085 DEL:\u007f LS:\u2028 PS:\u2029';
  const secondIssue = JSON.parse(pd(['create', '--tool', 'package-test', '--project', 'release', '--body', controlBody])).issue;
  const humanShow = pd(['show', issue.id, '--human']);
  assert.ok(humanShow.includes('Issue details\nID pd-1\nStatus open\n'));
  assert.ok(humanShow.includes('Comments (2)\n'));
  assert.ok(humanShow.includes('    日本語の確認です。\n    次の行です'));
  assert.equal(humanShow.includes('\u001b'), false);
  const firstHumanPage = pd(['list', '--human', '--limit', '1']);
  assert.ok(firstHumanPage.startsWith('Issues\npd-1  open  P2  task\n'));
  assert.ok(firstHumanPage.endsWith('\n  pd-1\n'));
  const secondHumanPage = pd(['list', '--human', '--after', 'pd-1', '--limit', '1']);
  assert.ok(secondHumanPage.startsWith(`Issues\n${secondIssue.id}  open  P2  task\n`));
  assert.ok(secondHumanPage.endsWith('\nEnd of results.\n'));
  const humanSearch = pd(['search', 'Package ESC', '--human']);
  assert.ok(humanSearch.includes('  Body: Package ESC:\\u001B[31m C1:\\u0085 DEL:\\u007F LS:\\u2028 PS:\\u2029'));
  assert.equal(JSON.parse(pd(['--json', 'show', issue.id])).issue.id, issue.id);
  const memoryCreation = ['memory', 'create', '--project', 'release', '--title', 'Package fact', '--body', 'Installed sessions share this memory.', '--request-id', '56361bb3-2f79-4e47-bd3a-4d0b52d9b7cc'];
  assert.equal(JSON.parse(pd(memoryCreation)).memory.id, 'pd-m1');
  assert.equal(JSON.parse(pd(['memory', 'context', '--project', 'release'])).memories[0].body, 'Installed sessions share this memory.');
  const observation = JSON.parse(pd(['memory', 'context', '--project', 'release', '--with-revision'])).memory_revision;
  const currentHumanRead = pd(['list', '--project', 'release', '--observed-memory-revision', observation, '--human']);
  assert.ok(currentHumanRead.includes('Memory freshness: current · project release\n'));
  assert.ok(currentHumanRead.includes('pd-1  open  P2  task'));
  assert.equal(JSON.parse(pd(['memory', 'update', '1', '--project', 'release', '--title', 'Package fact', '--body', 'Verified through the installed CLI.', '--expected', '1'])).memory.version, 2);
  const staleHumanRead = pd(['list', '--project', 'release', '--observed-memory-revision', observation, '--human']);
  assert.ok(staleHumanRead.includes('Memory freshness: stale · project release · memory changed\n'));
  assert.ok(staleHumanRead.includes('Retrieve project memory before acting.\n'));
  pd(['memory', 'delete', '1', '--project', 'release', '--expected', '1'], 4);
  const skill = readFileSync(join(installed, 'skills', 'polylinedb', 'SKILL.md'), 'utf8');
  assert.match(skill, /memory_context/);
  assert.match(skill, /context compaction/);
  const queueSkill = readFileSync(join(installed, 'skills', 'polylinedb-queue', 'SKILL.md'), 'utf8');
  assert.match(queueSkill, /named `queue`/);
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
  const blocker = JSON.parse(restored(['create', '--tool', 'package-test', '--project', 'other', '--body', 'Installed prerequisite'])).issue;
  const dependencyArgs = ['dependency', 'add', '--dependent', issue.id, '--blocker', blocker.id, '--expected-revision', '1', '--request-id', '11111111-1111-4111-8111-111111111111'];
  const dependency = JSON.parse(restored(dependencyArgs)); assert.equal(dependency.dependency.outcome, 'added');
  assert.deepEqual(JSON.parse(restored(dependencyArgs)), dependency);
  assert.equal(JSON.parse(restored(['dependency', 'list', issue.id])).blockers[0].id, blocker.id);
  assert.equal(JSON.parse(restored(['blocked', '--project', 'release'])).issues[0].id, issue.id);
  restored(['close', issue.id, '--expected', '4'], 4);
  const removal = JSON.parse(restored(['dependency', 'remove', '--dependent', issue.id, '--blocker', blocker.id, '--expected-revision', '2']));
  assert.equal(removal.dependency.outcome, 'removed'); assert.deepEqual(JSON.parse(restored(dependencyArgs)), dependency);
  assert.equal(JSON.parse(restored(['show', issue.id])).comments[0].body, 'Works from npm');
  const claim = JSON.parse(restored(['claim', 'show', issue.id])).claim;
  const sessionId = crypto.randomUUID(); const claimRequestId = crypto.randomUUID();
  const acquireArgs = ['claim', 'acquire', issue.id, '--incarnation', claim.store_incarnation, '--session-id', sessionId, '--request-id', claimRequestId, '--agent-label', 'Codex'];
  const owner = JSON.parse(restored(acquireArgs)); const lease = owner.claim_receipt;
  const proof = JSON.stringify({ issue_id: lease.issue_id, incarnation: lease.incarnation, session_id: lease.session_id, generation: lease.generation });
  assert.equal(JSON.parse(restored(['claim', 'list', '--project', 'release'])).claims[0].state, 'active');
  restored(['close', issue.id, '--expected', '4'], 4);
  assert.equal(JSON.parse(restored(['close', issue.id, '--expected', '4', '--claim-proof', proof])).issue.status, 'closed');
  assert.equal(JSON.parse(restored(['claim', 'renew', '--claim-proof', proof, '--expected-revision', '1', '--ttl', '30'])).claim_receipt.revision, 2);
  assert.deepEqual(JSON.parse(restored(acquireArgs)), owner);
  assert.equal(JSON.parse(restored(['claim', 'release', '--claim-proof', proof, '--expected-revision', '2'])).claim_receipt.outcome, 'released');
  restored(['reopen', issue.id, '--expected', '5', '--claim-proof', proof], 4);
  const reacquired = JSON.parse(restored(['claim', 'acquire', issue.id, '--incarnation', claim.store_incarnation, '--session-id', crypto.randomUUID()])).claim_receipt;
  const newProof = JSON.stringify({ issue_id: reacquired.issue_id, incarnation: reacquired.incarnation, session_id: reacquired.session_id, generation: reacquired.generation });
  assert.equal(JSON.parse(restored(['reopen', issue.id, '--expected', '5', '--claim-proof', newProof])).issue.status, 'open');
  assert.match(skill, /claim_acquire/);
  assert.equal(JSON.parse(restored(['memory', 'show', '1', '--project', 'release'])).memory.version, 2);
  assert.equal(JSON.parse(restored(memoryCreation)).memory.body, 'Verified through the installed CLI.');
  assert.equal(JSON.parse(restored(['create', '--tool', 'package-test', '--project', 'release', '--body', 'After restoration'])).issue.id, 'pd-4');
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
