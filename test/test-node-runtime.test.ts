// Exercise the preload before a child reaches its entry point, with the runtime version supplied by the CLI fixture.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const preload = new URL('../scripts/test-node-runtime.mjs', import.meta.url).href;
const simulation = new URL('./fixtures/cli-runtime-preload.mjs', import.meta.url).href;
const requiredNode = '^24.20.0 || >=26.7.0';

test('the test preload rejects unsupported versions before the entry point starts', () => {
  for (const version of ['20.20.2', '22.23.1', '24.19.0', '25.6.1', '26.6.9', '26.7.0-rc.1']) {
    const result = spawnSync(process.execPath, ['--import', simulation, '--import', preload, '-e', 'process.stdout.write("started")'], {
      encoding: 'utf8', env: { ...process.env, PD_TEST_NODE_VERSION: version },
    });
    assert.equal(result.status, 1, version);
    assert.equal(result.stdout, '', version);
    assert.equal(result.stderr, `Unsupported Node.js ${version}. Tests require Node.js ${requiredNode}.\n`, version);
  }
});

test('the test preload admits the supported lower bounds and later releases', () => {
  for (const version of ['24.20.0', '24.20.1', '24.99.0', '26.7.0', '26.7.1', '27.0.0']) {
    const result = spawnSync(process.execPath, ['--import', simulation, '--import', preload, '-e', 'process.stdout.write("started")'], {
      encoding: 'utf8', env: { ...process.env, PD_TEST_NODE_VERSION: version },
    });
    assert.equal(result.status, 0, version);
    assert.equal(result.stdout, 'started', version);
    assert.equal(result.stderr, '', version);
  }
});

test('npm test commands reject unsupported Node before the test runner starts', () => {
  for (const command of ['test', 'test:d1', 'test:properties', 'test:package']) {
    const result = spawnSync('npm', ['run', command], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: `--import=${simulation}`, PD_TEST_NODE_VERSION: '22.23.1' },
    });
    assert.equal(result.status, 1, command);
    assert.equal(result.stderr, `Unsupported Node.js 22.23.1. Tests require Node.js ${requiredNode}.\n`, command);
    assert.doesNotMatch(result.stdout, /TAP version|Subtest:|✔|✖|== test\//, command);
  }
});
