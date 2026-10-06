import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { mcpAnnotationsFor, operationSchemas, requiresExplicitLocalActor } from '../src/records/index.ts';

test('every MCP schema has operation policy annotations', () => {
  for (const name of Object.keys(operationSchemas)) {
    assert.equal(mcpAnnotationsFor(name).openWorldHint, false, name);
  }
});

test('policy lookups reject inherited object property names', () => {
  for (const name of ['constructor', 'toString', '__proto__', 'future_operation']) {
    assert.equal(requiresExplicitLocalActor(name), false, name);
    assert.throws(() => mcpAnnotationsFor(name), /Missing operation policy/);
  }
});

test('a new Operation variant fails at the policy table while the current union compiles', t => {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const operationSource = join(project, 'src', 'records', 'operations.ts');
  const policySource = join(project, 'src', 'records', 'operation-policy.ts');
  const compiler = join(project, 'node_modules', 'typescript', 'bin', 'tsc');
  const root = mkdtempSync(join(tmpdir(), 'polylinedb-operation-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policyCopy = join(root, 'operation-policy.ts');
  const operationsCopy = join(root, 'operations.ts');
  const compilerArgs = [compiler, '--noEmit', '--strict', '--target', 'ES2023', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', '--allowImportingTsExtensions', '--skipLibCheck', '--types', 'node',
    '--typeRoots', join(project, 'node_modules', '@types'), '--lib', 'ES2023,DOM,DOM.Iterable', policyCopy];
  copyFileSync(policySource, policyCopy);

  writeFileSync(operationsCopy, `import type { Operation as SourceOperation } from ${JSON.stringify(operationSource)};\nexport type Operation = SourceOperation;\n`);
  const control = spawnSync(process.execPath, compilerArgs, { cwd: root, encoding: 'utf8' });
  assert.ifError(control.error);
  assert.equal(control.status, 0, control.stdout + control.stderr);

  writeFileSync(operationsCopy, `import type { Operation as SourceOperation } from ${JSON.stringify(operationSource)};\nexport type Operation = SourceOperation | { op: 'unclassified_operation' };\n`);
  const mutation = spawnSync(process.execPath, compilerArgs, { cwd: root, encoding: 'utf8' });
  assert.ifError(mutation.error);
  assert.notEqual(mutation.status, 0, mutation.stdout + mutation.stderr);
  assert.match(mutation.stdout + mutation.stderr, /Property 'unclassified_operation' is missing/);
});
