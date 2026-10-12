// Test entry points must reject unsupported Node before loading tests or starting children.
// Use JavaScript so the check also runs on Node versions that cannot load TypeScript.
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const required = manifest.engines.node;
const actual = process.versions.node;
const version = /^(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(actual);
const clauses = required.split('||').map(clause => {
  const match = /^(\^|>=)(\d+)\.(\d+)\.(\d+)$/.exec(clause.trim());
  if (match === null || (match[1] === '^' && Number(match[2]) === 0)) {
    throw new Error(`Unsupported Node engine range clause: ${clause.trim()}`);
  }
  return { operator: match[1], floor: match.slice(2).map(Number) };
});
const supported = version !== null && clauses.some(({ operator, floor }) => {
  const current = version.slice(1).map(Number);
  const difference = current[0] - floor[0] || current[1] - floor[1] || current[2] - floor[2];
  return difference >= 0 && (operator === '>=' || current[0] === floor[0]);
});
if (!supported) {
  process.stderr.write(`Unsupported Node.js ${actual}. Tests require Node.js ${required}.\n`);
  process.exit(1);
}
