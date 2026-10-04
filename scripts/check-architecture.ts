// Proves declared boundaries with in-memory imports; user stores and source files stay untouched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative } from 'node:path';
import config from '../archstrict.config.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/archstrict/dist/cli.js', import.meta.url));
function reportFields(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an architecture report object');
  return Object.fromEntries(Object.entries(value));
}
function run(args: string[], expectedStatus: number, input?: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, input, encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, expectedStatus, `${result.stderr}\n${result.stdout}`);
  const report = reportFields(JSON.parse(result.stdout));
  assert.equal(report.error, undefined, JSON.stringify(report));
  return report;
}
const baseline = run(['check', '--json'], 0);
assert.deepEqual(baseline.violations, [], JSON.stringify(baseline.violations));
const worker = existsSync(new URL('../src/service/index.ts', import.meta.url)) ? 'src/service/index.ts' : 'src/worker.ts';
const records = existsSync(new URL('../src/records/issues.ts', import.meta.url)) ? 'src/records/issues.ts' : 'src/issues.ts';
const pathTo = (source: string, target: string) => {
  const path = relative(dirname(source), target);
  return path.startsWith('.') ? path : './' + path;
};
const modulePointer = (name: string) => {
  const index = config.declaredModules.findIndex(module => module.name === name);
  assert.ok(index >= 0, `Expected module ${name}`);
  return `declaredModules[${index}]`;
};
type Control = { name: string; path: string; statement: string; rule?: string; pointer?: string };
const controls: Control[] = [
  { name: 'CLI public cloud actions', path: 'src/cli.ts', statement: "import { createCloudClient as proof } from './cloud-client/index.ts'; void proof;" },
  { name: 'private OAuth implementation', path: 'src/cli.ts', statement: "import { createCloudAuth as proof } from './cloud-client/oauth.ts'; void proof;", rule: 'public-surface-bypass', pointer: modulePointer('cloud-client') },
  { name: 'Node to Worker', path: 'src/cli.ts', statement: `import { handleRequest as proof } from '${pathTo('src/cli.ts', worker)}'; void proof;`, rule: 'tag-boundary', pointer: 'edges.allowDeny[0].deny[0]' },
  { name: 'Worker to Node', path: worker, statement: `import { createCloudClient as proof } from '${pathTo(worker, 'src/cloud-client/index.ts')}'; void proof;`, rule: 'tag-boundary', pointer: 'edges.allowDeny[1].deny[0]' },
  { name: 'records to host', path: records, statement: `import { createCloudClient as proof } from '${pathTo(records, 'src/cloud-client/index.ts')}'; void proof;`, rule: 'tag-order', pointer: 'edges.order[0].sequence' },
  { name: 'portable Node builtin', path: records, statement: "import { readFileSync as proof } from 'node:fs'; void proof;", rule: 'tag-boundary', pointer: 'edges.allowDeny[2].deny[0]' },
  { name: 'Worker Node builtin', path: worker, statement: "import { readFileSync as proof } from 'node:fs'; void proof;", rule: 'tag-boundary', pointer: 'edges.allowDeny[3].deny[0]' },
  { name: 'public record commands', path: 'src/cli.ts', statement: "import { parseOperation as proof } from './records/index.ts'; void proof;" },
  { name: 'public record persistence', path: 'src/cli.ts', statement: "import { parseSnapshot as proof } from './records/persistence.ts'; void proof;" },
  { name: 'private issue behavior', path: 'src/cli.ts', statement: "import { parseOperation as proof } from './records/issues.ts'; void proof;", rule: 'public-surface-bypass', pointer: modulePointer('records') },
  { name: 'public local store', path: 'src/cli.ts', statement: "import { openStore as proof } from './local-store/index.ts'; void proof;" },
];
for (const control of controls) {
  const content = readFileSync(new URL(`../${control.path}`, import.meta.url), 'utf8') + '\n' + control.statement + '\n';
  const report = run(['simulate', '--whole-project', '--json'], control.rule ? 1 : 0, JSON.stringify({ changes: [{ path: control.path, content }] }));
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
