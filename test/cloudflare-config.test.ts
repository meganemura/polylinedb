// Evaluates cloudflare.config.ts in a fresh Node process per case, because the config reads the environment at import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const configUrl = new URL('../cloudflare.config.ts', import.meta.url).href;
const sentinel = 'sentinel-value-7f3a';
const complete = {
  POLYLINEDB_ACCESS_TEAM_DOMAIN: `${sentinel}.cloudflareaccess.com`,
  POLYLINEDB_ACCESS_AUD: `${sentinel}-audience`,
  POLYLINEDB_ACCESS_ACTORS: `["access:${sentinel}"]`,
  POLYLINEDB_ALLOWED_ORIGINS: `["https://${sentinel}.example"]`,
};
type Variable = keyof typeof complete;
const variables = Object.keys(complete) as Variable[];

function evaluate(overrides: Partial<Record<Variable | 'POLYLINEDB_BUILD_WITHOUT_ACCESS', string | undefined>>) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
  for (const [name, value] of Object.entries({ ...complete, ...overrides })) if (value !== undefined) env[name] = value;
  const script = `const { default: config } = await import(${JSON.stringify(configUrl)});
    process.stdout.write(JSON.stringify(config.worker.env));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, output: result.stdout + result.stderr };
}

function refused(result: ReturnType<typeof evaluate>, missing: Variable) {
  assert.notEqual(result.status, 0);
  assert.match(result.output, new RegExp(`${missing} is missing or empty`));
  assert.doesNotMatch(result.output, new RegExp(sentinel));
}

test('a complete environment passes every Access setting to the Worker', () => {
  const result = evaluate({});
  assert.equal(result.status, 0, result.output);
  const env = JSON.parse(result.stdout);
  assert.equal(env.ACCESS_TEAM_DOMAIN.value, complete.POLYLINEDB_ACCESS_TEAM_DOMAIN);
  assert.equal(env.ACCESS_AUD.value, complete.POLYLINEDB_ACCESS_AUD);
  assert.equal(env.ACCESS_ACTORS.value, complete.POLYLINEDB_ACCESS_ACTORS);
  assert.equal(env.ALLOWED_ORIGINS.value, complete.POLYLINEDB_ALLOWED_ORIGINS);
});

for (const variable of variables) {
  test(`an unset ${variable} stops the build and names only the variable`, () => {
    refused(evaluate({ [variable]: undefined }), variable);
  });
  test(`an empty ${variable} stops the build and names only the variable`, () => {
    refused(evaluate({ [variable]: '' }), variable);
    refused(evaluate({ [variable]: '  ' }), variable);
  });
}

test('an empty actor allowlist stops the build', () => {
  refused(evaluate({ POLYLINEDB_ACCESS_ACTORS: '[]' }), 'POLYLINEDB_ACCESS_ACTORS');
  refused(evaluate({ POLYLINEDB_ACCESS_ACTORS: ' [ ] ' }), 'POLYLINEDB_ACCESS_ACTORS');
});

test('an explicit empty origin list is a valid setting', () => {
  const result = evaluate({ POLYLINEDB_ALLOWED_ORIGINS: '[]' });
  assert.equal(result.status, 0, result.output);
  assert.equal(JSON.parse(result.stdout).ALLOWED_ORIGINS.value, '[]');
});

test('the local opt-in builds a Worker that refuses every request', () => {
  const unset = Object.fromEntries(variables.map(name => [name, undefined]));
  const result = evaluate({ ...unset, POLYLINEDB_BUILD_WITHOUT_ACCESS: '1' });
  assert.equal(result.status, 0, result.output);
  const env = JSON.parse(result.stdout);
  assert.equal(env.ACCESS_TEAM_DOMAIN.value, '');
  assert.equal(env.ACCESS_AUD.value, '');
  assert.equal(env.ACCESS_ACTORS.value, '[]');
  assert.equal(env.ALLOWED_ORIGINS.value, '[]');
});

test('the local opt-in replaces configured values so a deploy cannot mix them', () => {
  const result = evaluate({ POLYLINEDB_BUILD_WITHOUT_ACCESS: '1' });
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.stdout, new RegExp(sentinel));
});

test('the local opt-in accepts only the exact value 1', () => {
  for (const value of ['true', 'yes', '0', '']) {
    refused(evaluate({ POLYLINEDB_ACCESS_AUD: undefined, POLYLINEDB_BUILD_WITHOUT_ACCESS: value }), 'POLYLINEDB_ACCESS_AUD');
  }
});

test('the dev server runs Vite with remote bindings switched off', () => {
  // cf dev rejects --local, and its own local delegate needs a newer @cloudflare/vite-plugin.
  // The plugin reads this variable and then starts no remote proxy session, so it never asks for a login.
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scripts['dev:worker'], 'CLOUDFLARE_VITE_FORCE_LOCAL=true vite dev');
});
