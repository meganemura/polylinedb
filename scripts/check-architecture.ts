// Proves the declared boundaries with in-memory imports; user stores and source files stay untouched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/archstrict/dist/cli.js', import.meta.url));
function reportFields(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an architecture report object');
  return Object.fromEntries(Object.entries(value));
}
function run(args: string[], input?: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, input, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  const report = reportFields(JSON.parse(result.stdout));
  assert.equal(report.error, undefined, JSON.stringify(report));
  return report;
}
const baseline = run(['check', '--json']);
assert.deepEqual(baseline.violations, [], JSON.stringify(baseline.violations));

const controls = [
  { name: 'CLI public cloud actions', path: 'src/cli.ts', statement: "import { createCloudClient as proof } from './cloud-client/index.ts'; void proof;" },
  { name: 'private OAuth implementation', path: 'src/cli.ts', statement: "import { createCloudAuth as proof } from './cloud-client/oauth.ts'; void proof;", rule: 'public-surface-bypass', pointer: 'declaredModules[3]' },
  { name: 'Node to Worker', path: 'src/cli.ts', statement: "import { d1Executor as proof } from './d1.ts'; void proof;", rule: 'tag-boundary', pointer: 'edges.allowDeny[0].deny[0]' },
  { name: 'Worker to Node', path: 'src/worker.ts', statement: "import { createCloudClient as proof } from './cloud-client/index.ts'; void proof;", rule: 'tag-boundary', pointer: 'edges.allowDeny[1].deny[0]' },
  { name: 'records to host', path: 'src/issues.ts', statement: "import { createCloudClient as proof } from './cloud-client/index.ts'; void proof;", rule: 'tag-order', pointer: 'edges.order[0].sequence' },
  { name: 'portable Node builtin', path: 'src/issues.ts', statement: "import { readFileSync as proof } from 'node:fs'; void proof;", rule: 'tag-boundary', pointer: 'edges.allowDeny[2].deny[0]' },
  { name: 'Worker Node builtin', path: 'src/worker.ts', statement: "import { readFileSync as proof } from 'node:fs'; void proof;", rule: 'tag-boundary', pointer: 'edges.allowDeny[3].deny[0]' },
];
for (const control of controls) {
  const content = readFileSync(new URL(`../${control.path}`, import.meta.url), 'utf8') + '\n' + control.statement + '\n';
  const report = run(['simulate', '--whole-project', '--json'], JSON.stringify({ changes: [{ path: control.path, content }] }));
  assert.ok(Array.isArray(report.added), JSON.stringify(report));
  if (!control.rule) assert.deepEqual(report.added, [], control.name);
  else assert.ok(report.added.some((value: unknown) => {
    const violation = reportFields(value);
    const locations: unknown[] = Array.isArray(violation.config) ? violation.config : [violation.config];
    return violation.rule === control.rule && locations.some(location => location !== null && typeof location === 'object'
      && 'pointer' in location && location.pointer === control.pointer);
  }), `${control.name}: ${JSON.stringify(report.added)}`);
}
process.stdout.write(JSON.stringify({ modules: baseline.modules, edges: baseline.edges, type_leaks: baseline.typeLeaks,
  unresolved_specifiers: baseline.unresolvedSpecifiers, boundary_controls: controls.map(control => control.name) }) + '\n');
