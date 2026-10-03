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
  npm_config_cache: join(root, 'cache'), npm_config_audit: 'false', npm_config_fund: 'false' };
delete env.POLYLINEDB_ACTOR;
delete env.POLYLINEDB_DATA_DIR;

function run(command: string, args: string[], cwd: string, expected = 0): string {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, expected, `${command}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts=false', '--foreground-scripts=false', '--pack-destination', root], project));
  assert.equal(packed.length, 1);
  const pack = packed[0];
  assert.equal(pack.name, 'polylinedb');
  const expectedFiles = ['LICENSE', 'README.md', 'package.json', 'dist/cli.js', 'dist/issues.js',
    'dist/schema.js', 'dist/sqlite.js', 'dist/snapshot.js', 'dist/local-config.js', 'dist/issue-id.js',
    'dist/issue-queries.js', 'dist/solarsql.generated.js', 'docs/operations.md', 'skills/polylinedb/SKILL.md', 'docs/architecture.md',
    'docs/cloud.md', 'docs/d1-migration.md', 'docs/dependencies.md', 'docs/releasing.md', 'docs/adr/0001-field-versions.md', 'docs/adr/0002-solarsql-reads.md'].sort();
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
  assert.equal(JSON.parse(restored(['create', '--tool', 'package-test', '--project', 'release', '--body', 'After restoration'])).issue.id, 'pd-2');
  restored(['import', '--file', snapshotPath], 4);
  assert.deepEqual(readdirSync(workspace), []);
  assert.deepEqual(readdirSync(directory), ['polylinedb.sqlite']);
  const destination = process.argv[2];
  if (destination) {
    const { copyFileSync } = await import('node:fs');
    copyFileSync(tarball, resolve(destination));
  }
  process.stdout.write(JSON.stringify({ name: pack.name, version: pack.version, integrity: pack.integrity,
    files: pack.files.length, packedBytes: pack.size, node: process.version, result: 'pass' }) + '\n');
} finally { rmSync(root, { recursive: true, force: true }); }
